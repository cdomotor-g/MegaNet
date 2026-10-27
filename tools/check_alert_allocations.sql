-- check_alert_allocations.sql — Prove ALERT address allocations (0084) against
-- a real database: who may set an address aside, read one and release one;
-- what is refused, in words — an address out of range, held by a station in the
-- hub, set aside already, outside the named repeater's pass ranges; that the
-- same address in another hub is another address; and that a released one can
-- be set aside again.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_alert_allocations.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database. Run it
-- as a role is_editor() says yes to — a direct psql connection, or the service
-- key. CI runs it in the db-checks job after every migration has been applied
-- from zero.
--
-- What it does not check: the Pass Ranges tab's card and its pictures, which
-- are address-space.js's, held by test/passranges.mjs.

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
-- the SQLSTATE and the message (check_station_features.sql's helper, with the
-- message in place of the detail — the refusals here are in the message).
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      return v_state || '/' || v_msg;
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
-- Two hubs of our own; in the first a repeater passing 100–119 but not 110–111,
-- a field station holding 101 and 102, and a deleted one holding 103; in the
-- second a station holding 105. Three people: an editor, a stranger, nobody.

insert into meganet.rm_system (id, ord, name)
values (-984, -984, 'check_alert_allocations placeholder')
on conflict (id) do nothing;

insert into meganet.hub (id, ord, name) values
  ('_check_aa_hub',   -984, 'Check Allocation Hub'),
  ('_check_aa_other', -985, 'Check Other Hub')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, roles, hub_id) values
  ('_check_aa_rep',   -984, 'Check Allocation Peak AL', '998401', -984, '{repeater}', '_check_aa_hub'),
  ('_check_aa_field', -985, 'Check Allocation Creek',   '998402', -984, '{field}',    '_check_aa_hub'),
  ('_check_aa_gone',  -986, 'Check Allocation Gone',    '998403', -984, '{field}',    '_check_aa_hub'),
  ('_check_aa_far',   -987, 'Check Allocation Far',     '998404', -984, '{field}',    '_check_aa_other')
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_aa_gone';

insert into meganet.repeater (station_id) values ('_check_aa_rep') on conflict do nothing;
insert into meganet.pass_range (repeater_id, kind, lo, hi, ord) values
  ('_check_aa_rep', 'pass',      100, 119, 0),
  ('_check_aa_rep', 'exclusion', 110, 111, 0)
on conflict do nothing;

insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('_check_aa_field', '998402.0.R.101', 'Rainfall', 0, 101),
  ('_check_aa_field', '998402.0.B.102', 'Battery',  1, 102),
  ('_check_aa_gone',  '998403.0.R.103', 'Rainfall', 0, 103),
  ('_check_aa_far',   '998404.0.R.105', 'Rainfall', 0, 105)
on conflict do nothing;

insert into meganet.editor_allow (entry, note) values
  ('aa-editor@example.test', 'check_alert_allocations — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000f8401', 'aa-editor@example.test', now())
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000f8409"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"aa-editor@example.test","sub":"00000000-0000-4000-8000-0000000f8401"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.keep_as(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role_keep(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

create or replace function pg_temp.alloc_sql(p_hub text, p_ids int[], p_purpose text,
                                              p_rep text default null, p_stn text default null)
returns text language sql as $$
  select pg_catalog.format('select meganet.allocate_alert_ids(%L, %L::int[], %L, %L, %L)::text',
                           p_hub, p_ids, p_purpose, p_rep, p_stn)
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 84',
    (select value::integer >= 84 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('the table is there, with RLS on',
    (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.alert_allocation'::regclass),
    'db/README.md: no table without RLS, in the same file');
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('a signed-in role reads the allocations, nobody signed out does, and no browser role writes them',
      not has_table_privilege('anon', 'meganet.alert_allocation', 'select')
      and has_table_privilege('authenticated', 'meganet.alert_allocation', 'select')
      and not has_table_privilege('authenticated', 'meganet.alert_allocation', 'insert')
      and not has_table_privilege('authenticated', 'meganet.alert_allocation', 'update')
      and not has_table_privilege('authenticated', 'meganet.alert_allocation', 'delete'));
    perform pg_temp.check_that('…nobody signed out may run the doors, and nobody at all the internal',
      not has_function_privilege('anon', 'meganet.allocate_alert_ids(text, integer[], text, text, text)', 'execute')
      and not has_function_privilege('anon', 'meganet.release_alert_allocation(uuid[], text)', 'execute')
      and has_function_privilege('authenticated', 'meganet.allocate_alert_ids(text, integer[], text, text, text)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.repeater_passes(text, integer)', 'execute'));
  end if;
end
$$;

-- ── 2. The rule the app shares ───────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('repeater_passes(): in a pass range and no exclusion',
    meganet.repeater_passes('_check_aa_rep', 100) and meganet.repeater_passes('_check_aa_rep', 119)
    and not meganet.repeater_passes('_check_aa_rep', 110) and not meganet.repeater_passes('_check_aa_rep', 111)
    and not meganet.repeater_passes('_check_aa_rep', 120) and not meganet.repeater_passes('_check_aa_rep', 99));
end
$$;

-- ── 3. Who may ───────────────────────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_who('anon', pg_temp.alloc_sql('_check_aa_hub', '{104}', 'A new gauge'));
  perform pg_temp.check_that('nobody signed out sets an address aside', v like '42501/%', v);
  v := pg_temp.as_who('stranger', pg_temp.alloc_sql('_check_aa_hub', '{104}', 'A new gauge'));
  perform pg_temp.check_that('…nor does a stranger', v like '42501/%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{104}', 'A new gauge'));
  perform pg_temp.check_that('an editor does', v = 'ok', v);
end
$$;

-- ── 4. What is refused, in words ─────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{0}', 'A new gauge'));
  perform pg_temp.check_that('0 is not an ALERT address', v like '22023/%1 to 8191%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{8192}', 'A new gauge'));
  perform pg_temp.check_that('…nor is 8192', v like '22023/%8192%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{}', 'A new gauge'));
  perform pg_temp.check_that('no address at all is refused', v like '22023/%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{104,104}', 'A new gauge'));
  perform pg_temp.check_that('one address named twice is refused', v like '22023/%twice%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17}', 'A new gauge'));
  perform pg_temp.check_that('seventeen at a time is refused', v like '22023/%16%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{104}', '  '));
  perform pg_temp.check_that('an allocation says what it is for', v like '22023/%for%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_nowhere', '{104}', 'A new gauge'));
  perform pg_temp.check_that('a hub that is not one is refused', v like '22023/%_nowhere%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{101,104}', 'A new gauge'));
  perform pg_temp.check_that('an address a station in the hub holds is refused, naming the station — and the lot with it',
    v like '23505/%101 (Check Allocation Creek)%' and v not like '%104%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{103}', 'A new gauge'));
  perform pg_temp.check_that('…a deleted station''s address is free', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{105}', 'A new gauge'));
  perform pg_temp.check_that('…and so is one held only in another hub', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_other', '{105}', 'A new gauge'));
  perform pg_temp.check_that('…which in that hub is refused', v like '23505/%105 (Check Allocation Far)%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{110,120}', 'A new gauge', '_check_aa_rep'));
  perform pg_temp.check_that('addresses outside the named repeater''s ranges are refused, an exclusion among them',
    v like '22023/Check Allocation Peak AL''s pass ranges do not carry 110, 120%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{104}', 'A new gauge', '_check_aa_field'));
  perform pg_temp.check_that('a station that is not a repeater is not one', v like '22023/%no repeater%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{104}', 'A new gauge', null, '_check_aa_gone'));
  perform pg_temp.check_that('a deleted station is not one to set addresses aside for', v like '22023/%no station%', v);
end
$$;

-- ── 5. Kept, read, refused twice, released, set aside again ──────────────────

do $$
declare
  v    text;
  rows jsonb;
  ids  uuid[];
begin
  rows := pg_temp.keep_as('editor', pg_temp.alloc_sql('_check_aa_hub', '{113,112}', ' New   rain gauge at Check Flat ',
                                                      '_check_aa_rep', '_check_aa_field'))::jsonb;
  perform pg_temp.check_that('two set aside together: two rows, one batch, in address order, the purpose tidied, who and where kept',
    jsonb_array_length(rows) = 2 and rows -> 0 ->> 'batch' = rows -> 1 ->> 'batch'
    and (rows -> 0 ->> 'alert_id')::int = 112 and rows -> 0 ->> 'purpose' = 'New rain gauge at Check Flat'
    and rows -> 0 ->> 'created_by' = 'aa-editor@example.test' and rows -> 0 ->> 'repeater_id' = '_check_aa_rep'
    and rows -> 0 ->> 'station_id' = '_check_aa_field' and rows -> 0 ->> 'hub_id' = '_check_aa_hub',
    rows::text);
  select array_agg((e ->> 'id')::uuid) into ids from jsonb_array_elements(rows) e;

  v := pg_temp.keep_as('editor', 'select count(*)::text from meganet.alert_allocation where hub_id = ''_check_aa_hub''');
  perform pg_temp.check_that('an editor reads them', v = '2', v);
  v := pg_temp.keep_as('stranger', 'select count(*)::text from meganet.alert_allocation');
  perform pg_temp.check_that('…a stranger reads none', v = '0', v);

  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{114,113}', 'Another gauge'));
  perform pg_temp.check_that('an address set aside already is refused, naming what for', v like '23505/%113 (New rain gauge at Check Flat)%', v);
  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_other', '{113}', 'Another gauge'));
  perform pg_temp.check_that('…but in another hub it is another address', v = 'ok', v);

  v := pg_temp.as_who('stranger', pg_catalog.format('select meganet.release_alert_allocation(%L::uuid[])', ids));
  perform pg_temp.check_that('a stranger releases nothing', v like '42501/%', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.release_alert_allocation(%L::uuid[])', array[gen_random_uuid()]));
  perform pg_temp.check_that('an id that is not an allocation is refused', v like '22023/%', v);

  rows := pg_temp.keep_as('editor', pg_catalog.format('select meganet.release_alert_allocation(%L::uuid[], %L)::text', ids, 'Site moved'))::jsonb;
  perform pg_temp.check_that('released: the rows stay, with who, when and why',
    jsonb_array_length(rows) = 2 and rows -> 0 ->> 'released_by' = 'aa-editor@example.test'
    and rows -> 0 ->> 'released_at' is not null and rows -> 1 ->> 'release_note' = 'Site moved', rows::text);
  rows := pg_temp.keep_as('editor', pg_catalog.format('select meganet.release_alert_allocation(%L::uuid[])::text', ids))::jsonb;
  perform pg_temp.check_that('…releasing again answers them as they were', rows -> 0 ->> 'release_note' = 'Site moved', rows::text);

  v := pg_temp.as_who('editor', pg_temp.alloc_sql('_check_aa_hub', '{112,113}', 'The gauge, again', '_check_aa_rep'));
  perform pg_temp.check_that('a released address can be set aside again', v = 'ok', v);
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
