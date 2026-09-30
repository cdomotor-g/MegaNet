-- check_station_facing.sql — Prove the way a station faces (0044) against a
-- real database: what may be recorded, what the station document says of it,
-- and who may record it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_facing.sql
--
-- Every check below is one claim the head of 0044_station_facing.sql makes. The
-- whole script runs inside a transaction and rolls back, so it is safe against
-- the live database: nothing it writes survives. It needs a role
-- meganet.is_editor() says yes to — a direct psql connection, or one holding
-- the service key — and prints a row per check, exiting non-zero if any
-- failed. CI runs it in the db-checks job (.github/workflows/web-smoke.yml).
--
-- What it deliberately does not check: the Digital Twin turning the model to the
-- bearing it reads, which is test/twin.mjs's.

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

-- Run one statement as another role with the claims a request would carry, and
-- say how it ended — 'ok', or the SQLSTATE and the DETAIL line — then roll it
-- back, so every check starts from the same register (check_field_photos.sql's
-- helper, answering with the refusal rather than a value).
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

-- The same, as the connection running the script.
create or replace function pg_temp.refusal_of(p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
  v_det   text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_det = pg_exception_detail;
  return v_state || coalesce('/' || nullif(v_det, ''), '');
end;
$$;

-- A station as the editor would send it, over any of its fields.
create or replace function pg_temp.station(p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
           'id', '_check_facing_a', 'name', 'Check Facing Creek', 'station_number', '998441',
           'lat', -31.51, 'lon', 161.01, 'roles', jsonb_build_array('field'),
           'rm_system_id', -944, 'enabled', true, 'notes', '') || p_extra;
$$;

create or replace function pg_temp.save_sql(p_doc jsonb)
returns text language sql as $$
  select pg_catalog.format('select meganet.save_station(%L::jsonb, (select updated_at from meganet.station where id = %L))',
                           p_doc, p_doc ->> 'id');
$$;

create or replace function pg_temp.doc_of(p_id text)
returns jsonb language sql as $$
  select doc from meganet.station_json where id = p_id;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- A radio system, a station in the Tasman Sea, and an editor signed up the way
-- the signup triggers (0005) provision one.

insert into meganet.rm_system (id, ord, name)
values (-944, -944, 'check_station_facing placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_facing_a', -944, 'Check Facing Creek', '998441', -944, -31.51, 161.01, '{field}')
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('facing-editor@example.test', 'check_station_facing — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0f41', 'facing-editor@example.test')
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c0f49"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"facing-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f41"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- An editor's save, kept (as_role rolls its statement back; this does not).
create or replace function pg_temp.editor_saves(p_doc jsonb)
returns void language plpgsql as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"facing-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f41"}', true);
  perform meganet.save_station(p_doc, (select updated_at from meganet.station where id = p_doc ->> 'id'));
end;
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 44',
    (select value::integer from meganet.app_meta where key = 'schema_version') >= 44);
  perform pg_temp.check_that('meganet.station.facing_deg exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'meganet' and table_name = 'station' and column_name = 'facing_deg'));
  perform pg_temp.check_that('a station with none recorded has no facing_deg key',
    not (pg_temp.doc_of('_check_facing_a') ? 'facing_deg'));
end
$$;

-- ── 2. What may be recorded ──────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('an editor may record 135',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": 135}'))) = 'ok');
  perform pg_temp.check_that('…and 0',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": 0}'))) = 'ok');
  perform pg_temp.check_that('…and 359.5',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": 359.5}'))) = 'ok');
  perform pg_temp.check_that('…and "90" as the text a form sends',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": "90"}'))) = 'ok');
  perform pg_temp.check_that('361 is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": 361}'))) like '22023%');
  perform pg_temp.check_that('-10 is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": -10}'))) like '22023%');
  perform pg_temp.check_that('"south" is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": "south"}'))) like '22023%');
  perform pg_temp.check_that('true is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"facing_deg": true}'))) like '22023%');
  perform pg_temp.check_that('a stranger may not record one',
    pg_temp.as_who('stranger', pg_temp.save_sql(pg_temp.station('{"facing_deg": 90}'))) like '42501%');
  perform pg_temp.check_that('…nor anon',
    pg_temp.as_who('anon', pg_temp.save_sql(pg_temp.station('{"facing_deg": 90}'))) <> 'ok');
  perform pg_temp.check_that('the column''s own check refuses 360 from any other way in',
    pg_temp.refusal_of($q$update meganet.station set facing_deg = 360 where id = '_check_facing_a'$q$) like '23514%');
end
$$;

-- ── 3. What the document says ────────────────────────────────────────────────

do $$
declare
  d jsonb;
begin
  perform pg_temp.editor_saves(pg_temp.station('{"facing_deg": 360}'));
  d := pg_temp.doc_of('_check_facing_a');
  perform pg_temp.check_that('saved 360, the document says 0: the same bearing',
    (d ->> 'facing_deg')::numeric = 0, coalesce(d::text, '<missing>'));
  perform pg_temp.editor_saves(pg_temp.station('{"facing_deg": 112.5}'));
  d := pg_temp.doc_of('_check_facing_a');
  perform pg_temp.check_that('saved 112.5, the document says facing_deg 112.5, a number',
    jsonb_typeof(d -> 'facing_deg') = 'number' and (d ->> 'facing_deg')::numeric = 112.5, coalesce(d::text, '<missing>'));
  perform pg_temp.editor_saves(pg_temp.doc_of('_check_facing_a') || '{"notes": "renamed nothing"}'::jsonb);
  d := pg_temp.doc_of('_check_facing_a');
  perform pg_temp.check_that('a save of the document as loaded keeps the bearing',
    (d ->> 'facing_deg')::numeric = 112.5 and d ->> 'notes' = 'renamed nothing', coalesce(d::text, '<missing>'));
  perform pg_temp.editor_saves(pg_temp.doc_of('_check_facing_a') - 'facing_deg');
  d := pg_temp.doc_of('_check_facing_a');
  perform pg_temp.check_that('a save without the key clears it: not recorded, and absent from the document',
    not (d ? 'facing_deg') and (select facing_deg from meganet.station where id = '_check_facing_a') is null,
    coalesce(d::text, '<missing>'));
end
$$;

-- ── 4. The loader ────────────────────────────────────────────────────────────
-- The whole register back through load_stations_doc() with one station given
-- a bearing: it arrives, and nothing else is rewritten.

do $$
declare
  d      jsonb := meganet.stations_doc();
  before timestamptz;
  pick   text := (select id from meganet.station where id not like '\_check\_%' and deleted_at is null order by ord limit 1);
  got    jsonb;
begin
  d := jsonb_set(d, '{stations}',
    coalesce((select jsonb_agg(case when x.s ->> 'id' = pick then x.s || '{"facing_deg": 45}'::jsonb else x.s end order by x.o)
                from jsonb_array_elements(d -> 'stations') with ordinality x(s, o)
               where x.s ->> 'id' not like '\_check\_%'), '[]'::jsonb));
  before := (select max(updated_at) from meganet.station where id not like '\_check\_%' and id <> pick);
  perform meganet.load_stations_doc(d);
  got := pg_temp.doc_of(pick);
  perform pg_temp.check_that('load_stations_doc() records a bearing the document gives',
    (got ->> 'facing_deg')::numeric = 45, coalesce(got::text, '<missing>'));
  perform pg_temp.check_that('…and rewrites no other station',
    (select max(updated_at) from meganet.station where id not like '\_check\_%' and id <> pick) = before);
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
