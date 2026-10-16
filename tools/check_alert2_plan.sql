-- check_alert2_plan.sql — Prove the ALERT2 Transition Plan's shared stores
-- (0065) against a real database: who may read and set a site condition, that
-- a scenario is private to its author until shared and then seen by every
-- administrator and changed by its author only, and that nobody else — an
-- editor who is not an administrator, a member, nobody signed in — sees or
-- writes either.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_alert2_plan.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database: the
-- station, the people and their rows all go. Run it as a role is_admin() says
-- yes to — a direct psql connection, or the service key. CI runs it in the
-- db-checks job after every migration has been applied from zero.
--
-- What it deliberately does not check: the card, the plan's arithmetic and the
-- panel, which are alert2-plan.js's, held by test/a2plan.mjs.

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

-- One statement as another role with a request's claims, rolled back: 'ok', or
-- the SQLSTATE (check_station_features.sql's helper).
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

-- The same, kept, answering the statement's first column as text.
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

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- One repeater in the Tasman Sea, and six people: two administrators, an
-- editor who is not one, a member, a stranger, and nobody signed in.

insert into meganet.rm_system (id, ord, name)
values (-965, -965, 'check_alert2_plan placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_a2_rep', -965, 'Check Concentrator Hill', '996501', -965, -31.6, 161.1, '{repeater}')
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('a2-admin@example.test',  'check_alert2_plan — rolled back'),
  ('a2-other@example.test',  'check_alert2_plan — rolled back'),
  ('a2-editor@example.test', 'check_alert2_plan — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000a2001', 'a2-admin@example.test',  now()),
  ('00000000-0000-4000-8000-0000000a2002', 'a2-other@example.test',  now()),
  ('00000000-0000-4000-8000-0000000a2003', 'a2-editor@example.test', now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin', display_name = 'Check Admin'
 where id = '00000000-0000-4000-8000-0000000a2001';
update meganet.app_user set role = 'admin'
 where id = '00000000-0000-4000-8000-0000000a2002';

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000a2009"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"a2-editor@example.test","sub":"00000000-0000-4000-8000-0000000a2003"}'),
  ('admin',    'authenticated', '{"role":"authenticated","email":"a2-admin@example.test","sub":"00000000-0000-4000-8000-0000000a2001"}'),
  ('other',    'authenticated', '{"role":"authenticated","email":"a2-other@example.test","sub":"00000000-0000-4000-8000-0000000a2002"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.keep_as(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role_keep(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- What a person sees through the door: the read's sites and scenarios.
create or replace function pg_temp.read_as(p_who text)
returns jsonb language sql as $$
  select pg_temp.keep_as(p_who, 'select meganet.a2plan_read()::text')::jsonb;
$$;
create or replace function pg_temp.save_sql(p_id text, p_name text, p_notes text, p_shared boolean, p_settings jsonb)
returns text language sql as $$
  select pg_catalog.format('select meganet.a2plan_scenario_save(%L::uuid, %L, %L, %L::boolean, %L::jsonb)::text',
                           p_id, p_name, p_notes, p_shared, p_settings);
$$;

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('both tables have RLS on',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
      where c.oid in ('meganet.a2plan_site'::regclass, 'meganet.a2plan_scenario'::regclass)));
  perform pg_temp.check_that('the four doors are security definer with an empty search_path',
    (select count(*) = 4 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname in ('a2plan_read', 'a2plan_site_set', 'a2plan_scenario_save', 'a2plan_scenario_delete')
        and p.prosecdef and p.proconfig @> array['search_path=""']));
  perform pg_temp.check_that('nobody but the owner may execute them by default: public holds none',
    not pg_catalog.has_function_privilege('public', 'meganet.a2plan_read()', 'execute')
    and not pg_catalog.has_function_privilege('public', 'meganet.a2plan_site_set(text, text)', 'execute')
    and not pg_catalog.has_function_privilege('public', 'meganet.a2plan_scenario_save(uuid, text, text, boolean, jsonb)', 'execute')
    and not pg_catalog.has_function_privilege('public', 'meganet.a2plan_scenario_delete(uuid)', 'execute'));
  perform pg_temp.check_that('anon may neither read the tables nor call the doors',
    not pg_catalog.has_table_privilege('anon', 'meganet.a2plan_site', 'select')
    and not pg_catalog.has_table_privilege('anon', 'meganet.a2plan_scenario', 'select')
    and not pg_catalog.has_function_privilege('anon', 'meganet.a2plan_read()', 'execute'));
  perform pg_temp.check_that('no browser role may write either table directly',
    not pg_catalog.has_table_privilege('authenticated', 'meganet.a2plan_site', 'insert,update,delete')
    and not pg_catalog.has_table_privilege('authenticated', 'meganet.a2plan_scenario', 'insert,update,delete'));
end
$$;

-- ── 2. Site conditions ───────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
begin
  v := pg_temp.keep_as('admin', 'select meganet.a2plan_site_set(''_check_a2_rep'', ''rebuild'')::text');
  perform pg_temp.check_that('an administrator sets a site to rebuild, and is named as who set it',
    (v::jsonb ->> 'condition') = 'rebuild' and (v::jsonb ->> 'by') = 'Check Admin', v);
  r := pg_temp.read_as('other');
  perform pg_temp.check_that('another administrator reads the same answer',
    exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'sites') x
             where x ->> 'station_id' = '_check_a2_rep' and x ->> 'condition' = 'rebuild'), r::text);
  v := pg_temp.keep_as('other', 'select meganet.a2plan_site_set(''_check_a2_rep'', ''retrofit'')::text');
  perform pg_temp.check_that('…and may change it, and is then who set it',
    (v::jsonb ->> 'condition') = 'retrofit' and (v::jsonb ->> 'by') = 'a2-other@example.test', v);
  perform pg_temp.check_that('one row a site, whoever set it last',
    (select count(*) from meganet.a2plan_site where station_id = '_check_a2_rep') = 1);

  v := pg_temp.as_who('admin', 'select meganet.a2plan_site_set(''_check_a2_rep'', ''demolish'')');
  perform pg_temp.check_that('a condition that is not fit, retrofit or rebuild is refused', v = '22023', v);
  v := pg_temp.as_who('admin', 'select meganet.a2plan_site_set(''_check_no_such_station'', ''fit'')');
  perform pg_temp.check_that('a station that is not in the register is refused', v = '22023', v);
  v := pg_temp.as_who('editor', 'select meganet.a2plan_site_set(''_check_a2_rep'', ''fit'')');
  perform pg_temp.check_that('an editor who is not an administrator may not set one', v = '42501', v);
  v := pg_temp.as_who('stranger', 'select meganet.a2plan_site_set(''_check_a2_rep'', ''fit'')');
  perform pg_temp.check_that('nor may a stranger', v = '42501', v);
  v := pg_temp.as_who('anon', 'select meganet.a2plan_site_set(''_check_a2_rep'', ''fit'')');
  perform pg_temp.check_that('nor anybody signed out — they may not call it at all', v = '42501', v);
  v := pg_temp.as_who('editor', 'select meganet.a2plan_read()');
  perform pg_temp.check_that('an editor who is not an administrator may not read the plan''s state', v = '42501', v);
  v := pg_temp.keep_as('editor', 'select count(*)::text from meganet.a2plan_site');
  perform pg_temp.check_that('…nor see a site condition by reading the table', v = '0', v);

  v := pg_temp.keep_as('admin', 'select meganet.a2plan_site_set(''_check_a2_rep'', null)::text');
  perform pg_temp.check_that('clearing it puts the site back to not assessed: no row',
    (v::jsonb -> 'condition') = 'null'::jsonb
    and not exists (select 1 from meganet.a2plan_site where station_id = '_check_a2_rep'), v);
end
$$;

-- ── 3. Scenarios ─────────────────────────────────────────────────────────────

create temporary table _ids (k text primary key, id uuid) on commit drop;

do $$
declare
  v   text;
  r   jsonb;
  sid uuid;
begin
  v := pg_temp.keep_as('admin', pg_temp.save_sql(null, 'Faster, two rebuild crews', 'For the June meeting', null,
                                                 '{"v":1,"fieldCrews":6,"rebuildCrews":2}'));
  sid := (v::jsonb ->> 'id')::uuid;
  insert into _ids values ('mine', sid);
  perform pg_temp.check_that('an administrator saves a scenario, private unless they say',
    sid is not null and (v::jsonb ->> 'shared') = 'false' and (v::jsonb ->> 'mine') = 'true'
    and (v::jsonb -> 'settings' ->> 'fieldCrews') = '6', v);

  r := pg_temp.read_as('admin');
  perform pg_temp.check_that('its author sees it',
    exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'scenarios') x where (x ->> 'id')::uuid = sid), r::text);
  r := pg_temp.read_as('other');
  perform pg_temp.check_that('another administrator does not, while it is private',
    not exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'scenarios') x where (x ->> 'id')::uuid = sid), r::text);
  v := pg_temp.keep_as('other', pg_catalog.format('select count(*)::text from meganet.a2plan_scenario where id = %L', sid));
  perform pg_temp.check_that('…not even by reading the table', v = '0', v);
  v := pg_temp.as_who('other', pg_temp.save_sql(sid::text, 'Mine now', null, true, null));
  perform pg_temp.check_that('…and cannot change it: to them it is not there', v = 'P0002', v);

  v := pg_temp.keep_as('admin', pg_temp.save_sql(sid::text, null, null, true, null));
  perform pg_temp.check_that('its author shares it, and nothing else about it changes',
    (v::jsonb ->> 'shared') = 'true' and (v::jsonb ->> 'name') = 'Faster, two rebuild crews'
    and (v::jsonb ->> 'notes') = 'For the June meeting' and (v::jsonb -> 'settings' ->> 'rebuildCrews') = '2', v);
  r := pg_temp.read_as('other');
  perform pg_temp.check_that('shared, every administrator sees it, with who saved it and that it is not theirs',
    exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'scenarios') x
             where (x ->> 'id')::uuid = sid and x ->> 'by' = 'Check Admin' and x ->> 'mine' = 'false'), r::text);
  v := pg_temp.as_who('other', pg_temp.save_sql(sid::text, 'Mine now', null, null, null));
  perform pg_temp.check_that('…but only its author may change it', v = '42501', v);
  v := pg_temp.as_who('other', pg_catalog.format('select meganet.a2plan_scenario_delete(%L)', sid));
  perform pg_temp.check_that('…or delete it', v = '42501', v);
  v := pg_temp.keep_as('other', pg_temp.save_sql(null, 'My copy of Faster', null, null, (r -> 'scenarios' -> 0 -> 'settings')));
  perform pg_temp.check_that('another administrator saves their own copy, private to them',
    (v::jsonb ->> 'mine') = 'true' and (v::jsonb ->> 'shared') = 'false' and (v::jsonb ->> 'by') = 'a2-other@example.test', v);
  insert into _ids values ('copy', (v::jsonb ->> 'id')::uuid);

  v := pg_temp.as_who('editor', 'select meganet.a2plan_read()');
  perform pg_temp.check_that('an editor who is not an administrator sees no scenario, shared or not', v = '42501', v);
  v := pg_temp.keep_as('editor', 'select count(*)::text from meganet.a2plan_scenario');
  perform pg_temp.check_that('…not even by reading the table', v = '0', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(null, 'Sneaky', null, true, '{}'));
  perform pg_temp.check_that('…and may not save one', v = '42501', v);
  v := pg_temp.as_who('anon', 'select count(*) from meganet.a2plan_scenario');
  perform pg_temp.check_that('signed out, the table is not there to read', v = '42501', v);

  v := pg_temp.as_who('admin', pg_temp.save_sql(null, '   ', null, null, '{}'));
  perform pg_temp.check_that('a blank name is refused', v = '22023', v);
  v := pg_temp.as_who('admin', pg_temp.save_sql(null, 'A list', null, null, '[1,2]'));
  perform pg_temp.check_that('settings that are not an object are refused', v = '22023', v);
  v := pg_temp.as_who('admin', pg_temp.save_sql(null, 'Huge', null, null,
         jsonb_build_object('pad', repeat('x', 70000))));
  perform pg_temp.check_that('settings over 64 KB are refused', v = '22023', v);
  v := pg_temp.as_who('admin', pg_temp.save_sql(null, 'Long notes', repeat('n', 2001), null, '{}'));
  perform pg_temp.check_that('notes over 2,000 characters are refused', v = '22023', v);

  v := pg_temp.keep_as('admin', pg_temp.save_sql(sid::text, null, null, false, null));
  r := pg_temp.read_as('other');
  perform pg_temp.check_that('made private again, the others no longer see it — their copy stays theirs',
    (v::jsonb ->> 'shared') = 'false'
    and not exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'scenarios') x where (x ->> 'id')::uuid = sid)
    and exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'scenarios') x where (x ->> 'id')::uuid = (select i.id from _ids i where k = 'copy')), r::text);

  v := pg_temp.keep_as('admin', pg_catalog.format('select meganet.a2plan_scenario_delete(%L)::text', sid));
  perform pg_temp.check_that('its author deletes it', v = 'true' and not exists (select 1 from meganet.a2plan_scenario where a2plan_scenario.id = sid), v);
  v := pg_temp.keep_as('admin', pg_catalog.format('select meganet.a2plan_scenario_delete(%L)::text', sid));
  perform pg_temp.check_that('deleting it again answers false rather than refusing', v = 'false', v);
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

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
