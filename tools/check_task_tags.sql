-- check_task_tags.sql — Prove tags on tasks (0118) against a real database:
-- that every approved account reads the tag list and nobody else does; that a
-- task's team and whoever manages it tag it, a new name making a new tag and
-- a known one (case aside) using it, and that anybody else is refused; that
-- every tag change goes in the thread; that only an administrator renames,
-- recolours, retires, merges and removes a tag — a retired one staying on its
-- tasks, a merge moving every task across with its thread saying so, and a
-- tag on any task not removed; and that the three starter tags are there.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_task_tags.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database. Run
-- it as a direct psql connection. CI runs it in the db-checks job after every
-- migration has been applied from zero, after check_teams_and_tasks.sql.
--
-- What it deliberately does not check: the Tasks tab's tag picker and filter
-- and the Admin tab's Tags panel, which test/tasks.mjs holds.

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
-- or the SQLSTATE it was refused with (check_teams_and_tasks.sql's helper).
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
-- A station in the Tasman Sea, and the people: an administrator, a member of
-- a team that hands out tasks, the owner of team A, a member of team A, an
-- approved account on no team, an account still waiting, and nobody signed in.

update meganet.app_meta set value = 'open' where key = 'signup';

insert into meganet.rm_system (id, ord, name)
values (-969, -969, 'check_task_tags placeholder')
on conflict (id) do nothing;
insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_tg_stn', -969, 'Check Tag Creek', '996901', -969, -31.9, 161.4, '{field}')
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('tg-admin@example.test', 'check_task_tags — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000a7101', 'tg-admin@example.test',       now()),
  ('00000000-0000-4000-8000-0000000a7102', 'tg-sort@example.invalid',     now()),
  ('00000000-0000-4000-8000-0000000a7103', 'tg-owner@example.invalid',    now()),
  ('00000000-0000-4000-8000-0000000a7104', 'tg-member@example.invalid',   now()),
  ('00000000-0000-4000-8000-0000000a7106', 'tg-outsider@example.invalid', now()),
  ('00000000-0000-4000-8000-0000000a7107', 'tg-waiting@example.invalid',  now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin', display_name = 'Check Admin' where id = '00000000-0000-4000-8000-0000000a7101';
update meganet.app_user set status = 'approved', display_name = 'Check Sort' where id = '00000000-0000-4000-8000-0000000a7102';
update meganet.app_user set status = 'approved', display_name = 'Check Owner' where id = '00000000-0000-4000-8000-0000000a7103';
update meganet.app_user set status = 'approved', display_name = 'Check Member' where id = '00000000-0000-4000-8000-0000000a7104';
update meganet.app_user set status = 'approved', display_name = 'Check Outsider' where id = '00000000-0000-4000-8000-0000000a7106';

insert into meganet.team (id, name, hands_out) values
  ('00000000-0000-4000-8000-0000000b7101', 'Check Tag Handers', true),
  ('00000000-0000-4000-8000-0000000b7102', 'Check Tag Team A', false)
on conflict do nothing;
insert into meganet.team_member (team_id, user_id, is_owner) values
  ('00000000-0000-4000-8000-0000000b7101', '00000000-0000-4000-8000-0000000a7102', false),
  ('00000000-0000-4000-8000-0000000b7102', '00000000-0000-4000-8000-0000000a7103', true),
  ('00000000-0000-4000-8000-0000000b7102', '00000000-0000-4000-8000-0000000a7104', false)
on conflict do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('admin',    'authenticated', '{"role":"authenticated","email":"tg-admin@example.test","sub":"00000000-0000-4000-8000-0000000a7101"}'),
  ('sort',     'authenticated', '{"role":"authenticated","email":"tg-sort@example.invalid","sub":"00000000-0000-4000-8000-0000000a7102"}'),
  ('owner',    'authenticated', '{"role":"authenticated","email":"tg-owner@example.invalid","sub":"00000000-0000-4000-8000-0000000a7103"}'),
  ('member',   'authenticated', '{"role":"authenticated","email":"tg-member@example.invalid","sub":"00000000-0000-4000-8000-0000000a7104"}'),
  ('outsider', 'authenticated', '{"role":"authenticated","email":"tg-outsider@example.invalid","sub":"00000000-0000-4000-8000-0000000a7106"}'),
  ('waiting',  'authenticated', '{"role":"authenticated","email":"tg-waiting@example.invalid","sub":"00000000-0000-4000-8000-0000000a7107"}');

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

create temporary table _ids (k text primary key, id uuid) on commit drop;
create or replace function pg_temp.id_of(p_k text) returns uuid language sql as $$
  select i.id from _ids i where i.k = p_k;
$$;
-- A task's tags by name, as the doors say them.
create or replace function pg_temp.tags_of(p_task jsonb) returns text language sql as $$
  select coalesce((select pg_catalog.string_agg(x ->> 'name', ',' order by pg_catalog.lower(x ->> 'name'))
                     from pg_catalog.jsonb_array_elements(p_task -> 'tags') x), '');
$$;
create or replace function pg_temp.tag_in(p_read jsonb, p_name text) returns jsonb language sql as $$
  select x from pg_catalog.jsonb_array_elements(p_read -> 'tags') x where pg_catalog.lower(x ->> 'name') = pg_catalog.lower(p_name);
$$;

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('both tables have RLS on, and no policy',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
      where c.oid in ('meganet.task_tag'::regclass, 'meganet.task_tagging'::regclass))
    and not exists (select 1 from pg_catalog.pg_policy p
                     where p.polrelid in ('meganet.task_tag'::regclass, 'meganet.task_tagging'::regclass)));
  perform pg_temp.check_that('the doors are security definer with an empty search_path',
    (select count(*) = 4 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname in ('tags_read', 'tag_save', 'tag_merge', 'tag_remove')
        and p.prosecdef and p.proconfig @> array['search_path=""']));
  perform pg_temp.check_that('the three starter tags are there, each with a meaning',
    (select count(*) = 3 from meganet.task_tag g
      where g.name in ('RTS', 'QA', 'Assessment') and g.meaning <> '' and g.retired_at is null));
end
$$;

-- ── 2. Who reads the list ────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
begin
  v := pg_temp.as_who('anon', 'select meganet.tags_read()');
  perform pg_temp.check_that('nobody signed in reads the tags', v in ('42501', '42883'), v);
  v := pg_temp.as_who('waiting', 'select meganet.tags_read()');
  perform pg_temp.check_that('an account still waiting is refused them', v = '42501', v);
  v := pg_temp.keep_as('member', 'select count(*) from meganet.task_tag');
  perform pg_temp.check_that('the table is not read directly, even by an approved account', v like 'ERROR 42501' or v = '0', v);
  r := pg_temp.json_as('outsider', 'select meganet.tags_read()::text');
  perform pg_temp.check_that('an approved account on no team reads the names and meanings',
    pg_temp.tag_in(r, 'RTS') ->> 'meaning' like 'Return to service%', r::text);
  perform pg_temp.check_that('…but not who made a tag nor how many tasks have it',
    not (pg_temp.tag_in(r, 'RTS') ? 'created_by') and not (pg_temp.tag_in(r, 'RTS') ? 'tasks'), r::text);
  perform pg_temp.check_that('…and is told it may not make one', not (r -> 'me' ->> 'may_tag')::boolean, r::text);
  r := pg_temp.json_as('admin', 'select meganet.tags_read()::text');
  perform pg_temp.check_that('an administrator sees how many tasks have each',
    (pg_temp.tag_in(r, 'RTS') ->> 'tasks') is not null and (r -> 'me' ->> 'admin')::boolean, r::text);
end
$$;

-- ── 3. Tagging tasks ─────────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
  t jsonb;
  n integer;
begin
  -- Made with tags: a known one in another case, and a new one with a meaning.
  r := pg_temp.json_as('sort', $q$select meganet.task_create('[{"station_id":"_check_tg_stn","title":"Check tagged one",
        "team_id":"00000000-0000-4000-8000-0000000b7102",
        "tags":["rts", {"name":"Check  Fence","meaning":"Fence work at the site."}]}]')::text$q$);
  insert into _ids values ('one', (r -> 'created' -> 0 ->> 'id')::uuid);
  t := pg_temp.json_as('member', pg_catalog.format('select meganet.task_get(%L)::text', pg_temp.id_of('one')));
  perform pg_temp.check_that('a task is made with its tags — a known name in any case is that tag',
    pg_temp.tags_of(t) = 'Check Fence,RTS', t::text);
  perform pg_temp.check_that('…a new name makes a new tag, its spaces closed up, with the meaning it was given',
    (select g.meaning from meganet.task_tag g where g.name = 'Check Fence') = 'Fence work at the site.');
  perform pg_temp.check_that('…its thread says it was tagged',
    exists (select 1 from meganet.task_note nn where nn.task_id = pg_temp.id_of('one') and nn.kind = 'tags'
             and nn.to_value = 'Check Fence, RTS'));
  perform pg_temp.check_that('the list says each task''s tags, with their colours',
    (select pg_temp.tags_of(x) from pg_catalog.jsonb_array_elements(pg_temp.json_as('member', 'select meganet.task_list()::text')) x
      where x ->> 'id' = pg_temp.id_of('one')::text) = 'Check Fence,RTS'
    and (select x -> 'tags' -> 0 ->> 'colour' from pg_catalog.jsonb_array_elements(pg_temp.json_as('member', 'select meganet.task_list()::text')) x
      where x ->> 'id' = pg_temp.id_of('one')::text) is not null);

  -- Its team changes them: the whole list as it is to be.
  t := pg_temp.json_as('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["QA","RTS"],"note":"Checked the data."}')::text$q$,
         pg_temp.id_of('one')));
  perform pg_temp.check_that('its team changes its tags', pg_temp.tags_of(t) = 'QA,RTS', t::text);
  perform pg_temp.check_that('…the thread keeps before and after, and the note with it',
    exists (select 1 from meganet.task_note nn where nn.task_id = pg_temp.id_of('one') and nn.kind = 'tags'
             and nn.from_value = 'Check Fence, RTS' and nn.to_value = 'QA, RTS' and nn.body = 'Checked the data.'));
  select count(*) into n from meganet.task_note nn where nn.task_id = pg_temp.id_of('one');
  t := pg_temp.json_as('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["rts","qa"]}')::text$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('the same tags again change nothing and write nothing',
    pg_temp.tags_of(t) = 'QA,RTS' and (select count(*) from meganet.task_note nn where nn.task_id = pg_temp.id_of('one')) = n, t::text);

  v := pg_temp.as_who('outsider', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["QA"]}')$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('somebody the task is not for cannot tag it', v = 'P0002', v);
  v := pg_temp.as_who('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["a,b"]}')$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('a tag with a comma is refused', v = '22023', v);
  v := pg_temp.as_who('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["%s"]}')$q$, pg_temp.id_of('one'), repeat('x', 31)));
  perform pg_temp.check_that('a tag of more than 30 characters is refused', v = '22023', v);
  v := pg_temp.as_who('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":"QA"}')$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('tags that are not a list are refused', v = '22023', v);
  v := pg_temp.as_who('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10","t11","t12","t13"]}')$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('more than 12 tags on a task are refused, and no new tag is left behind', v = '22023'
    and not exists (select 1 from meganet.task_tag g where g.name = 't1'), v);
  t := pg_temp.json_as('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":[]}')::text$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('an empty list takes every tag off', pg_temp.tags_of(t) = '', t::text);
  t := pg_temp.json_as('owner', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["Assessment"]}')::text$q$, pg_temp.id_of('one')));
  perform pg_temp.check_that('its team''s owner tags it too', pg_temp.tags_of(t) = 'Assessment', t::text);
end
$$;

-- ── 4. Making and changing tags ──────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
  t jsonb;
begin
  r := pg_temp.json_as('member', $q$select meganet.tag_save(null, 'Check Solar', 'Solar panel work.')::text$q$);
  perform pg_temp.check_that('somebody on a team makes a tag on its own',
    pg_temp.tag_in(r, 'Check Solar') ->> 'meaning' = 'Solar panel work.', r::text);
  v := pg_temp.as_who('outsider', $q$select meganet.tag_save(null, 'Check Nope', '')$q$);
  perform pg_temp.check_that('an approved account tasks are not for may not', v = '42501', v);
  v := pg_temp.as_who('member', $q$select meganet.tag_save(null, 'check solar', '')$q$);
  perform pg_temp.check_that('a name another tag has, case aside, is refused', v = '23505', v);
  insert into _ids values ('solar', (pg_temp.tag_in(r, 'Check Solar') ->> 'id')::uuid),
                          ('fence', (select g.id from meganet.task_tag g where g.name = 'Check Fence')),
                          ('assess', (select g.id from meganet.task_tag g where g.name = 'Assessment'));

  v := pg_temp.as_who('sort', pg_catalog.format($q$select meganet.tag_save(%L, 'Check Sun', '', 'amber', null)$q$, pg_temp.id_of('solar')));
  perform pg_temp.check_that('only an administrator changes a tag — not even somebody who hands out tasks', v = '42501', v);
  r := pg_temp.json_as('admin', pg_catalog.format($q$select meganet.tag_save(%L, 'Check Sun', 'Solar power.', 'amber', null)::text$q$, pg_temp.id_of('solar')));
  perform pg_temp.check_that('an administrator renames, re-words and recolours one',
    pg_temp.tag_in(r, 'Check Sun') ->> 'colour' = 'amber' and pg_temp.tag_in(r, 'Check Sun') ->> 'meaning' = 'Solar power.', r::text);
  v := pg_temp.as_who('admin', pg_catalog.format($q$select meganet.tag_save(%L, 'Check Sun', '', 'mauve', null)$q$, pg_temp.id_of('solar')));
  perform pg_temp.check_that('a colour not on the list is refused', v = '22023', v);

  -- Retired: still on its tasks, still read, marked so.
  r := pg_temp.json_as('admin', pg_catalog.format($q$select meganet.tag_save(%L, 'Assessment', %L, null, true)::text$q$,
         pg_temp.id_of('assess'), (select g.meaning from meganet.task_tag g where g.id = pg_temp.id_of('assess'))));
  perform pg_temp.check_that('an administrator retires a tag', (pg_temp.tag_in(r, 'Assessment') ->> 'retired')::boolean, r::text);
  t := pg_temp.json_as('member', pg_catalog.format('select meganet.task_get(%L)::text', pg_temp.id_of('one')));
  perform pg_temp.check_that('…which stays on the tasks that have it', pg_temp.tags_of(t) = 'Assessment', t::text);
  r := pg_temp.json_as('admin', pg_catalog.format($q$select meganet.tag_save(%L, 'Assessment', %L, null, false)::text$q$,
         pg_temp.id_of('assess'), (select g.meaning from meganet.task_tag g where g.id = pg_temp.id_of('assess'))));
  perform pg_temp.check_that('…and brings it back', not (pg_temp.tag_in(r, 'Assessment') ->> 'retired')::boolean, r::text);

  -- Merge: Check Fence's tasks get Assessment instead.
  perform pg_temp.json_as('member', pg_catalog.format($q$select meganet.task_update(%L, '{"tags":["Check Fence","Assessment"]}')::text$q$, pg_temp.id_of('one')));
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.tag_merge(%L, %L)', pg_temp.id_of('fence'), pg_temp.id_of('assess')));
  perform pg_temp.check_that('only an administrator merges tags', v = '42501', v);
  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.tag_merge(%L, %L)::text', pg_temp.id_of('fence'), pg_temp.id_of('assess')));
  perform pg_temp.check_that('a merge removes the one that goes', pg_temp.tag_in(r, 'Check Fence') is null, r::text);
  t := pg_temp.json_as('member', pg_catalog.format('select meganet.task_get(%L)::text', pg_temp.id_of('one')));
  perform pg_temp.check_that('…a task that had both has the one kept, once', pg_temp.tags_of(t) = 'Assessment', t::text);
  perform pg_temp.check_that('…and its thread says it was merged',
    exists (select 1 from meganet.task_note nn where nn.task_id = pg_temp.id_of('one') and nn.kind = 'tags'
             and nn.body like 'The tag Check Fence was merged into Assessment%'));

  -- Remove: only one no task has.
  v := pg_temp.as_who('admin', pg_catalog.format('select meganet.tag_remove(%L)', pg_temp.id_of('assess')));
  perform pg_temp.check_that('a tag on a task is not removed', v = '23503', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.tag_remove(%L)', pg_temp.id_of('solar')));
  perform pg_temp.check_that('only an administrator removes a tag', v = '42501', v);
  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.tag_remove(%L)::text', pg_temp.id_of('solar')));
  perform pg_temp.check_that('an administrator removes one no task has', pg_temp.tag_in(r, 'Check Sun') is null, r::text);

  -- A task removed takes its tagging with it.
  delete from meganet.task where id = pg_temp.id_of('one');
  perform pg_temp.check_that('a task gone leaves no tagging behind',
    not exists (select 1 from meganet.task_tagging x where x.task_id = pg_temp.id_of('one')));
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
