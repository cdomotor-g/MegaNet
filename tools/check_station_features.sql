-- check_station_features.sql — Prove a station's site features (0061) against
-- a real database: what a geometry may be, what each kind's shape is, who may
-- add, change, delete and read one, a stale write refused, and a point on the
-- wrong station's map refused in words.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_features.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database: the
-- stations, the people and the features all go. Run it as a role is_editor()
-- says yes to — a direct psql connection, or the service key. CI runs it in the
-- db-checks job after every migration has been applied from zero.
--
-- One transaction means one now(), so a row's stamp cannot move between two
-- saves in here the way it does between two requests. Where a check needs it
-- to, the row is first dated back with its touch trigger held off (as the
-- owner, rolled back with everything else) — `backdate` below.
--
-- What it deliberately does not check: drawing, snapping, the GPS and the
-- panel, which are site-features.js's, held by test/sitefeatures.mjs.

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
-- the SQLSTATE and the DETAIL line (check_proposed_stations.sql's helper).
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
  v_det   text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_det = pg_exception_detail;
      return v_state || coalesce('/' || nullif(v_det, ''), '');
  end;
end;
$$;

-- The same, kept, answering the statement's first column as text: for the
-- writes the next checks read. An error here stops the script, which is right
-- — a fixture that did not take makes every check after it meaningless.
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
-- Three stations in the Tasman Sea — one with a pin, one without, one deleted —
-- and five people: two editors, a stranger, nobody signed in, and the service
-- key.

insert into meganet.rm_system (id, ord, name)
values (-961, -961, 'check_station_features placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_sf_stn',    -961, 'Check Feature Creek',   '996101', -961, -31.7, 161.2, '{field}'),
  ('_check_sf_nopin',  -962, 'Check Featureless Bay', '996102', -961, null,  null,  '{field}'),
  ('_check_sf_gone',   -963, 'Check Feature Gone',    '996103', -961, -31.8, 161.3, '{field}')
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_sf_gone';

insert into meganet.editor_allow (entry, note) values
  ('sf-editor@example.test', 'check_station_features — rolled back'),
  ('sf-other@example.test',  'check_station_features — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000f6101', 'sf-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000f6102', 'sf-other@example.test', now())
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000f6109"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"sf-editor@example.test","sub":"00000000-0000-4000-8000-0000000f6101"}'),
  ('other',    'authenticated', '{"role":"authenticated","email":"sf-other@example.test","sub":"00000000-0000-4000-8000-0000000f6102"}'),
  ('service',  'service_role',  '{"role":"service_role"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.keep_as(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role_keep(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- The two doors, as SQL a role runs.
create or replace function pg_temp.save_sql(p_feature jsonb, p_expected timestamptz default null)
returns text language sql as $$
  select pg_catalog.format('select meganet.save_station_feature(%L::jsonb, %L::timestamptz)::text', p_feature, p_expected)
$$;
create or replace function pg_temp.delete_sql(p_id text, p_expected timestamptz)
returns text language sql as $$
  select pg_catalog.format('select meganet.delete_station_feature(%L::uuid, %L::timestamptz)::text', p_id, p_expected)
$$;

-- A feature as the panel sends one: a point at the pin plus (dx, dy) metres.
create or replace function pg_temp.point(p_kind text, p_dx numeric default 0, p_dy numeric default 0,
                                         p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('station_id', '_check_sf_stn', 'kind', p_kind,
           'geom', jsonb_build_object('type', 'Point', 'coordinates',
             jsonb_build_array(161.2 + p_dx / (111320.0 * cos(radians(31.7))), -31.7 + p_dy / 110574.0)))
         || p_extra;
$$;

-- Date a row back, so the next save has a stamp it can be seen to move from.
create or replace function pg_temp.backdate(p_id text, p_at timestamptz default '2026-01-01T00:00:00Z')
returns timestamptz language plpgsql as $$
begin
  alter table meganet.station_feature disable trigger station_feature_touch_updated_at;
  update meganet.station_feature set updated_at = p_at where id = p_id::uuid;
  alter table meganet.station_feature enable trigger station_feature_touch_updated_at;
  return p_at;
end;
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 61',
    (select value::integer >= 61 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('both tables are there, each with RLS on',
    (select count(*) = 2 and bool_and(c.relrowsecurity) from pg_catalog.pg_class c
      where c.oid in ('meganet.station_feature'::regclass, 'meganet.station_feature_kind'::regclass)),
    'db/README.md: no table without RLS, in the same file');

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('anybody reads the vocabulary, only a signed-in role the features, and no browser role writes either',
      has_table_privilege('anon', 'meganet.station_feature_kind', 'select')
      and not has_table_privilege('anon', 'meganet.station_feature', 'select')
      and has_table_privilege('authenticated', 'meganet.station_feature', 'select')
      and not has_table_privilege('authenticated', 'meganet.station_feature', 'insert')
      and not has_table_privilege('authenticated', 'meganet.station_feature', 'update')
      and not has_table_privilege('authenticated', 'meganet.station_feature', 'delete')
      and not has_table_privilege('authenticated', 'meganet.station_feature_kind', 'insert'));
    perform pg_temp.check_that('…nobody signed out may run the doors, and nobody at all the internals',
      not has_function_privilege('anon', 'meganet.save_station_feature(jsonb, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'meganet.delete_station_feature(uuid, timestamptz)', 'execute')
      and has_function_privilege('authenticated', 'meganet.save_station_feature(jsonb, timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.station_feature_round(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.station_feature_geom_problem(jsonb)', 'execute'));
  end if;
end
$$;

-- ── 2. The vocabulary ────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('the orifice outlet, the pits, the benchmarks and the gauge boards are points',
    (select count(*) = 4 from meganet.station_feature_kind
      where key in ('orifice_outlet', 'pit', 'benchmark', 'gauge_board') and geometry = 'Point'));
  perform pg_temp.check_that('…and the orifice run is a line',
    exists (select 1 from meganet.station_feature_kind where key = 'orifice_run' and geometry = 'LineString'));
  perform pg_temp.check_that('only the two "other" kinds have to be named',
    (select array_agg(key order by key) = '{other_line,other_point}' from meganet.station_feature_kind where needs_name));
  perform pg_temp.check_that('…and the access track (0067) is a line, after the cable run and before any other line',
    exists (select 1 from meganet.station_feature_kind
             where key = 'access_track' and geometry = 'LineString' and ord > 120 and ord < 190));
end
$$;

-- ── 3. What a geometry may be ────────────────────────────────────────────────

do $$
declare
  big jsonb;
begin
  select jsonb_build_object('type', 'LineString', 'coordinates',
           jsonb_agg(jsonb_build_array(161.2 + i * 0.00001, -31.7))) into big
    from generate_series(1, 501) i;

  perform pg_temp.check_that('a point and a line that goes somewhere are geometries',
    meganet.station_feature_geom_problem('{"type":"Point","coordinates":[161.2,-31.7]}') is null
    and meganet.station_feature_geom_problem('{"type":"LineString","coordinates":[[161.2,-31.7],[161.2001,-31.7001]]}') is null);
  perform pg_temp.check_that('a position is two numbers, longitude first, in range',
    meganet.station_feature_geom_problem('{"type":"Point","coordinates":[161.2,-31.7,4.2]}') is not null
    and meganet.station_feature_geom_problem('{"type":"Point","coordinates":["161.2","-31.7"]}') is not null
    and meganet.station_feature_geom_problem('{"type":"Point","coordinates":[200,-31.7]}') like '%longitude%'
    and meganet.station_feature_geom_problem('{"type":"Point","coordinates":[161.2,-95]}') like '%latitude%');
  perform pg_temp.check_that('a line is 2 to 500 points, and not one point repeated',
    meganet.station_feature_geom_problem('{"type":"LineString","coordinates":[[161.2,-31.7]]}') like '%at least two%'
    and meganet.station_feature_geom_problem(big) like '%at most 500%'
    and meganet.station_feature_geom_problem('{"type":"LineString","coordinates":[[161.2,-31.7],[161.20,-31.70]]}') like '%go somewhere%'
    and meganet.station_feature_geom_problem('{"type":"LineString","coordinates":[[161.2,-31.7],[161.2001,-31.7],[999,0]]}') like 'point 3 of the line%');
  perform pg_temp.check_that('a geometry is a Point or a LineString, carrying nothing else',
    meganet.station_feature_geom_problem('{"type":"Polygon","coordinates":[[[161.2,-31.7],[161.3,-31.7],[161.2,-31.8],[161.2,-31.7]]]}') is not null
    and meganet.station_feature_geom_problem('{"type":"Point","coordinates":[161.2,-31.7],"bbox":[161.2,-31.7,161.2,-31.7]}') is not null
    and meganet.station_feature_geom_problem(null) is not null
    and meganet.station_feature_geom_problem('[161.2,-31.7]') is not null);
  perform pg_temp.check_that('coordinates are kept to seven places, with no zeros trailing',
    meganet.station_feature_round('{"type":"Point","coordinates":[161.123456789,-31.10]}')
      = '{"type":"Point","coordinates":[161.1234568,-31.1]}'::jsonb
    and (meganet.station_feature_round('{"type":"Point","coordinates":[161.123456789,-31.10]}') #>> '{coordinates,1}') = '-31.1');
  perform pg_temp.check_that('the reach is the farthest point from the pin, in metres, and nothing without a pin',
    meganet.station_feature_reach_m('{"type":"Point","coordinates":[161.2,-31.7]}', -31.7, 161.2) = 0
    and meganet.station_feature_reach_m('{"type":"LineString","coordinates":[[161.2,-31.7],[161.2,-31.69]]}', -31.7, 161.2)
        between 1105 and 1106
    and meganet.station_feature_reach_m('{"type":"Point","coordinates":[161.2,-31.7]}', null, null) is null);
end
$$;

-- The table holds the same line whatever writes to it — here the owner,
-- going round the doors.
do $$
declare
  v_state text;
begin
  begin
    insert into meganet.station_feature (station_id, kind, geom, created_by, updated_by)
    values ('_check_sf_stn', 'benchmark', '{"type":"LineString","coordinates":[[161.2,-31.7],[161.2001,-31.7]]}', 'check', 'check');
    v_state := 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check_that('a benchmark cannot be a line, however it is written', v_state = '23503', v_state);
  begin
    insert into meganet.station_feature (station_id, kind, geom, created_by, updated_by)
    values ('_check_sf_stn', 'pit', '{"type":"Point","coordinates":[161.2,-131.7]}', 'check', 'check');
    v_state := 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check_that('…nor a point be off the earth', v_state = '23514', v_state);
  begin
    insert into meganet.station_feature (station_id, kind, geom, placed, accuracy_m, created_by, updated_by)
    values ('_check_sf_stn', 'pit', '{"type":"Point","coordinates":[161.2,-31.7]}', 'map', 3, 'check', 'check');
    v_state := 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check_that('…nor a position clicked on the map carry a GPS''s ±', v_state = '23514', v_state);
end
$$;

-- ── 4. Who may add one ───────────────────────────────────────────────────────

do $$
declare
  v text;
begin
  v := pg_temp.as_who('anon', pg_temp.save_sql(pg_temp.point('pit')));
  perform pg_temp.check_that('nobody signed out adds a feature', v = '42501', v);
  v := pg_temp.as_who('stranger', pg_temp.save_sql(pg_temp.point('pit')));
  perform pg_temp.check_that('…nor somebody signed in who is not an editor', v = '42501', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit')));
  perform pg_temp.check_that('an editor does', v = 'ok', v);
  v := pg_temp.as_who('service', pg_temp.save_sql(pg_temp.point('pit')));
  perform pg_temp.check_that('…and so does the service key', v = 'ok', v);
end
$$;

-- ── 5. Adding ────────────────────────────────────────────────────────────────

create temporary table _f (k text primary key, id text, stamp timestamptz) on commit drop;

do $$
declare
  j jsonb;
  v text;
begin
  j := pg_temp.keep_as('editor', pg_temp.save_sql(pg_temp.point('orifice_outlet', 40, -12,
         '{"name":" Outlet ,  left bank ","note":"Under the bottom board."}')))::jsonb;
  insert into _f values ('outlet', j ->> 'id', (j ->> 'updated_at')::timestamptz);
  perform pg_temp.check_that('an orifice outlet is added, and the answer is the row as saved',
    j ->> 'kind' = 'orifice_outlet' and j ->> 'station_id' = '_check_sf_stn' and j ->> 'placed' = 'map'
    and j ->> 'created_by' = 'sf-editor@example.test' and j ->> 'updated_by' = 'sf-editor@example.test'
    and j ->> 'note' = 'Under the bottom board.' and not (j ? 'deleted_at') and not (j ? 'geom_type'),
    j::text);
  perform pg_temp.check_that('…its name tidied of stray spaces, its coordinates to seven places',
    j ->> 'name' = 'Outlet , left bank'
    and (select bool_and(length(split_part(c #>> '{}', '.', 2)) <= 7) from jsonb_array_elements(j #> '{geom,coordinates}') c),
    j::text);

  j := pg_temp.keep_as('editor', pg_temp.save_sql(jsonb_build_object('station_id', '_check_sf_stn', 'kind', 'orifice_run',
         'geom', '{"type":"LineString","coordinates":[[161.2,-31.7],[161.2002,-31.7001],[161.20042,-31.70011]]}'::jsonb,
         'bbox', null) - 'bbox'))::jsonb;
  insert into _f values ('run', j ->> 'id', (j ->> 'updated_at')::timestamptz);
  perform pg_temp.check_that('an orifice run is added through three points',
    j ->> 'kind' = 'orifice_run' and jsonb_array_length(j #> '{geom,coordinates}') = 3, j::text);

  v := pg_temp.as_who('editor', pg_temp.save_sql(jsonb_build_object('station_id', '_check_sf_stn', 'kind', 'orifice_run',
         'geom', '{"type":"LineString","coordinates":[[161.2,-31.7],[161.20000001,-31.70000001]]}'::jsonb)));
  perform pg_temp.check_that('a line whose two points round onto one is refused', v = '22023', v);

  j := pg_temp.keep_as('editor', pg_temp.save_sql(pg_temp.point('benchmark', -30, 25,
         '{"name":"BM1","placed":"gps","accuracy_m":4.567}')))::jsonb;
  insert into _f values ('bm1', j ->> 'id', (j ->> 'updated_at')::timestamptz);
  perform pg_temp.check_that('a benchmark placed by GPS keeps its ±, to the centimetre',
    j ->> 'placed' = 'gps' and (j ->> 'accuracy_m')::numeric = 4.57, j::text);
  j := pg_temp.keep_as('editor', pg_temp.save_sql(pg_temp.point('gauge_board', 5, -20,
         '{"name":"Board 0–1 m","placed":"typed","accuracy_m":3}')))::jsonb;
  insert into _f values ('board', j ->> 'id', (j ->> 'updated_at')::timestamptz);
  perform pg_temp.check_that('…and a ± sent with a typed position is not kept', j ->> 'accuracy_m' is null, j::text);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('benchmark', 0, 0, '{"name":"bm1"}')));
  perform pg_temp.check_that('two benchmarks at one station do not share a name', v = '23505', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit', 0, 0, '{"name":"BM1"}')));
  perform pg_temp.check_that('…but a pit may carry it', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit', 8, 8)));
  perform pg_temp.check_that('…and unnamed pits repeat freely', v = 'ok', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('other_point', 3, 3)));
  perform pg_temp.check_that('an "other point" with no name is refused', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('other_point', 3, 3, '{"name":"Gate"}')));
  perform pg_temp.check_that('…and with one is added', v = 'ok', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('orifice_run')));
  perform pg_temp.check_that('an orifice run cannot be a point', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('waterfall')));
  perform pg_temp.check_that('a kind that is not in the vocabulary is refused', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit', 0, 0, '{"colour":"red"}')));
  perform pg_temp.check_that('a key the door does not know is refused', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit') - 'geom'));
  perform pg_temp.check_that('a new feature has to say where it is', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit'), now()));
  perform pg_temp.check_that('a new feature carries no stamp', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit', 0, 0, '{"placed":"guessed"}')));
  perform pg_temp.check_that('a position is placed on the map, by GPS, typed or mixed — nothing else', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit', 0, 0, '{"placed":"gps","accuracy_m":5000}')));
  perform pg_temp.check_that('…and a GPS ± of 5 km is not one to keep a position with', v = '22023', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('benchmark', 0, 12000, '{"name":"BM far"}')));
  perform pg_temp.check_that('a point 12 km from the pin is the wrong station''s map, and refused', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('benchmark', 0, 9000, '{"name":"PSM up the road"}')));
  perform pg_temp.check_that('…a State mark 9 km up the road is not', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit', 0, 50000) || '{"station_id":"_check_sf_nopin"}'));
  perform pg_temp.check_that('a station with no pin has nothing to be far from', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit') || '{"station_id":"_check_sf_gone"}'));
  perform pg_temp.check_that('a deleted station takes no new features', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('pit') || '{"station_id":"_check_sf_nowhere"}'));
  perform pg_temp.check_that('…nor does one that is not there', v = '22023', v);
end
$$;

-- ── 6. Changing one ──────────────────────────────────────────────────────────

do $$
declare
  f      _f%rowtype;
  stamp  timestamptz;
  j      jsonb;
  v      text;
begin
  select * into f from _f where k = 'outlet';
  stamp := pg_temp.backdate(f.id);

  v := pg_temp.as_who('other', pg_temp.save_sql(jsonb_build_object('id', f.id, 'note', 'Moved after the 2026 flood.'),
                                                '2025-06-30T00:00:00Z'));
  perform pg_temp.check_that('a change read before somebody else''s is refused', v = 'PT409', v);
  v := pg_temp.as_who('other', pg_temp.save_sql(jsonb_build_object('id', f.id, 'note', 'Moved after the 2026 flood.')));
  perform pg_temp.check_that('…and so is one that does not say when it was read', v = 'PT409', v);

  j := pg_temp.keep_as('other', pg_temp.save_sql(jsonb_build_object('id', f.id, 'kind', 'orifice_outlet',
         'name', 'Outlet , left bank', 'note', 'Under the bottom board.', 'placed', 'map',
         'geom', (select geom from meganet.station_feature where id = f.id::uuid)), stamp))::jsonb;
  perform pg_temp.check_that('a save that changes nothing writes nothing, and keeps the stamp',
    (j ->> 'updated_at')::timestamptz = stamp and j ->> 'updated_by' = 'sf-editor@example.test', j::text);

  j := pg_temp.keep_as('other', pg_temp.save_sql(jsonb_build_object('id', f.id, 'note', 'Moved after the 2026 flood.'), stamp))::jsonb;
  perform pg_temp.check_that('a change with the right stamp lands, as its maker, with a new stamp',
    j ->> 'note' = 'Moved after the 2026 flood.' and j ->> 'updated_by' = 'sf-other@example.test'
    and j ->> 'created_by' = 'sf-editor@example.test' and (j ->> 'updated_at')::timestamptz <> stamp, j::text);
  perform pg_temp.check_that('…and what it did not mention is as it was',
    j ->> 'name' = 'Outlet , left bank' and j ->> 'kind' = 'orifice_outlet'
    and j -> 'geom' = (select geom from meganet.station_feature where id = f.id::uuid), j::text);

  stamp := pg_temp.backdate(f.id);
  v := pg_temp.as_who('editor', pg_temp.save_sql(jsonb_build_object('id', f.id, 'station_id', '_check_sf_nopin'), stamp));
  perform pg_temp.check_that('a feature stays with its station', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(jsonb_build_object('id', f.id, 'kind', 'orifice_run'), stamp));
  perform pg_temp.check_that('…and with its shape: a point does not become a line by its kind', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(jsonb_build_object('id', f.id, 'kind', 'pit'), stamp));
  perform pg_temp.check_that('…though it may become another kind of point', v = 'ok', v);
  v := pg_temp.as_who('stranger', pg_temp.save_sql(jsonb_build_object('id', f.id, 'note', 'x'), stamp));
  perform pg_temp.check_that('somebody who is not an editor changes nothing', v = '42501', v);
end
$$;

-- ── 7. Reading ───────────────────────────────────────────────────────────────

do $$
declare
  v text;
begin
  -- The four kept above: the outlet, the run, BM1 and the board. Every other
  -- save in here was a role's statement rolled back (as_who).
  v := pg_temp.keep_as('editor', 'select count(*)::text from meganet.station_feature where station_id = ''_check_sf_stn''');
  perform pg_temp.check_that('an editor reads a station''s features', v = '4', v);
  v := pg_temp.keep_as('stranger', 'select count(*)::text from meganet.station_feature');
  perform pg_temp.check_that('…somebody signed in who is not an editor reads none', v = '0', v);
  v := pg_temp.as_who('anon', 'select count(*) from meganet.station_feature');
  perform pg_temp.check_that('…and nobody signed out may ask', v = '42501', v);
  v := pg_temp.keep_as('anon', 'select count(*)::text from meganet.station_feature_kind');
  perform pg_temp.check_that('the vocabulary is anybody''s', v::integer >= 9, v);
end
$$;

-- ── 8. Deleting ──────────────────────────────────────────────────────────────

do $$
declare
  f      _f%rowtype;
  stamp  timestamptz;
  j      jsonb;
  v      text;
begin
  select * into f from _f where k = 'bm1';
  stamp := pg_temp.backdate(f.id);

  v := pg_temp.as_who('stranger', pg_temp.delete_sql(f.id, stamp));
  perform pg_temp.check_that('somebody who is not an editor deletes nothing', v = '42501', v);
  v := pg_temp.as_who('editor', pg_temp.delete_sql(f.id, '2025-06-30T00:00:00Z'));
  perform pg_temp.check_that('a delete read before a change is refused', v = 'PT409', v);
  j := pg_temp.keep_as('other', pg_temp.delete_sql(f.id, stamp))::jsonb;
  perform pg_temp.check_that('an editor deletes one with its stamp', j ->> 'id' = f.id and j ? 'deleted_at', j::text);
  perform pg_temp.check_that('…the row is kept, with who and when',
    exists (select 1 from meganet.station_feature where id = f.id::uuid
             and deleted_by = 'sf-other@example.test' and deleted_at is not null));
  v := pg_temp.keep_as('editor', pg_catalog.format('select count(*)::text from meganet.station_feature where id = %L', f.id));
  perform pg_temp.check_that('…and editors stop seeing it', v = '0', v);
  v := pg_temp.as_who('editor', pg_temp.delete_sql(f.id, stamp));
  perform pg_temp.check_that('deleting it again answers the same, rather than refusing', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(jsonb_build_object('id', f.id, 'note', 'x'), stamp));
  perform pg_temp.check_that('a change to a deleted feature is refused as stale', v = 'PT409', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.point('benchmark', -30, 25, '{"name":"BM1"}')));
  perform pg_temp.check_that('its name is free again', v = 'ok', v);
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
