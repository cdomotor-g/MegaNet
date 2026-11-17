-- check_station_antenna_decommissioned.sql — Prove a station's own antenna
-- height and its decommissioning (0125) against a real database: what may be
-- recorded, what the station document says of it, and who may record it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_antenna_decommissioned.sql
--
-- Every check below is one claim the head of
-- 0125_station_antenna_decommissioned.sql makes. The whole script runs inside a
-- transaction and rolls back, so it is safe against the live database: nothing
-- it writes survives. It needs a role meganet.is_editor() says yes to — a
-- direct psql connection, or one holding the service key. CI runs it in the
-- db-checks job (.github/workflows/web-smoke.yml). The helpers are
-- check_tower_height.sql's.

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
           'id', '_check_antdec_a', 'name', 'Check Antenna Creek', 'station_number', '998425',
           'lat', -31.51, 'lon', 161.01, 'roles', jsonb_build_array('field'),
           'rm_system_id', -925, 'enabled', true, 'notes', '') || p_extra;
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
values (-925, -925, 'check_station_antenna_decommissioned placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_antdec_a', -925, 'Check Antenna Creek', '998425', -925, -31.51, 161.01, '{field}')
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('antdec-editor@example.test', 'check_station_antenna_decommissioned — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c0f25', 'antdec-editor@example.test', now())
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c0f29"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"antdec-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f25"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- An editor's save, kept (as_role rolls its statement back; this does not).
create or replace function pg_temp.editor_saves(p_doc jsonb)
returns void language plpgsql as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"antdec-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f25"}', true);
  perform meganet.save_station(p_doc, (select updated_at from meganet.station where id = p_doc ->> 'id'));
end;
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 125',
    (select value::integer from meganet.app_meta where key = 'schema_version') >= 125);
  perform pg_temp.check_that('the three columns exist',
    (select count(*) from information_schema.columns
      where table_schema = 'meganet' and table_name = 'station'
        and column_name in ('antenna_height_m', 'decommissioned', 'decommissioned_year')) = 3);
  perform pg_temp.check_that('in the loaded register no station gains a key it does not have',
    not exists (select 1 from meganet.station_json j join meganet.station s on s.id = j.id
                 where j.id not like '\_check\_%'
                   and ((j.doc ? 'antenna_height_m') <> (s.antenna_height_m is not null)
                        or (j.doc ? 'decommissioned') <> s.decommissioned
                        or (j.doc ? 'decommissioned_year') <> (s.decommissioned_year is not null))));
  perform pg_temp.check_that('a station with none recorded has none of the keys',
    not (pg_temp.doc_of('_check_antdec_a') ?| array['antenna_height_m', 'decommissioned', 'decommissioned_year']));
end
$$;

-- ── 2. What may be recorded ──────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('an editor may record an antenna 12.5 m up',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"antenna_height_m": 12.5}'))) = 'ok');
  perform pg_temp.check_that('…and "6" as the text a form sends',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"antenna_height_m": "6"}'))) = 'ok');
  perform pg_temp.check_that('0 is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"antenna_height_m": 0}'))) like '22023%');
  perform pg_temp.check_that('151 is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"antenna_height_m": 151}'))) like '22023%');
  perform pg_temp.check_that('"high" is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"antenna_height_m": "high"}'))) like '22023%');
  perform pg_temp.check_that('a stranger may not record one',
    pg_temp.as_who('stranger', pg_temp.save_sql(pg_temp.station('{"antenna_height_m": 8}'))) like '42501%');
  perform pg_temp.check_that('the column''s own check refuses -1 from any other way in',
    pg_temp.refusal_of($q$update meganet.station set antenna_height_m = -1 where id = '_check_antdec_a'$q$) like '23514%');

  perform pg_temp.check_that('an editor may decommission a station, with the year',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"decommissioned": true, "decommissioned_year": 2025}'))) = 'ok');
  perform pg_temp.check_that('…or without one',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"decommissioned": true}'))) = 'ok');
  perform pg_temp.check_that('"yes" is refused: decommissioned is true or false',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"decommissioned": "yes"}'))) like '22023%');
  perform pg_temp.check_that('a year of 1850 is refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"decommissioned": true, "decommissioned_year": 1850}'))) like '22023%');
  perform pg_temp.check_that('proposed and decommissioned together are refused',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station(
      '{"decommissioned": true, "proposed": true, "station_type": "auto_rain_gauge", "proposed_year": 2027}'))) like '22023%');
  perform pg_temp.check_that('…and by the table''s own check from any other way in',
    pg_temp.refusal_of($q$update meganet.station set proposed = true, decommissioned = true where id = '_check_antdec_a'$q$) like '23514%');
  perform pg_temp.check_that('a stranger may not decommission one',
    pg_temp.as_who('stranger', pg_temp.save_sql(pg_temp.station('{"decommissioned": true}'))) like '42501%');
end
$$;

-- ── 3. What the document says ────────────────────────────────────────────────

do $$
declare
  d jsonb;
begin
  perform pg_temp.editor_saves(pg_temp.station('{"antenna_height_m": 12.5, "decommissioned": true, "decommissioned_year": 2025}'));
  d := pg_temp.doc_of('_check_antdec_a');
  perform pg_temp.check_that('the document says antenna_height_m 12.5, a number',
    jsonb_typeof(d -> 'antenna_height_m') = 'number' and (d ->> 'antenna_height_m')::numeric = 12.5, coalesce(d::text, '<missing>'));
  perform pg_temp.check_that('…decommissioned true and the year 2025',
    d -> 'decommissioned' = 'true'::jsonb and (d ->> 'decommissioned_year')::integer = 2025, coalesce(d::text, '<missing>'));
  perform pg_temp.check_that('a decommissioned station stays in the station document',
    exists (select 1 from jsonb_array_elements(meganet.stations_doc() -> 'stations') x where x ->> 'id' = '_check_antdec_a'));
  perform pg_temp.editor_saves(pg_temp.doc_of('_check_antdec_a') || '{"notes": "kept"}'::jsonb);
  d := pg_temp.doc_of('_check_antdec_a');
  perform pg_temp.check_that('a save of the document as loaded keeps all three',
    (d ->> 'antenna_height_m')::numeric = 12.5 and d ? 'decommissioned' and d ? 'decommissioned_year'
      and d ->> 'notes' = 'kept', coalesce(d::text, '<missing>'));
  perform pg_temp.editor_saves(pg_temp.doc_of('_check_antdec_a') - 'antenna_height_m' - 'decommissioned' - 'decommissioned_year');
  d := pg_temp.doc_of('_check_antdec_a');
  perform pg_temp.check_that('a save without the keys clears them: brought back into service, height not recorded',
    not (d ?| array['antenna_height_m', 'decommissioned', 'decommissioned_year'])
      and not (select decommissioned from meganet.station where id = '_check_antdec_a'),
    coalesce(d::text, '<missing>'));
end
$$;

-- ── 4. The loader ────────────────────────────────────────────────────────────
-- The whole register back through load_stations_doc() with one station given
-- all three: they arrive, and nothing else is rewritten.

do $$
declare
  d      jsonb := meganet.stations_doc();
  before timestamptz;
  pick   text := (select id from meganet.station where id not like '\_check\_%' and deleted_at is null
                     and not proposed order by ord limit 1);
  got    jsonb;
begin
  d := jsonb_set(d, '{stations}',
    coalesce((select jsonb_agg(case when x.s ->> 'id' = pick
                                    then x.s || '{"antenna_height_m": 9.5, "decommissioned": true, "decommissioned_year": 2024}'::jsonb
                                    else x.s end order by x.o)
                from jsonb_array_elements(d -> 'stations') with ordinality x(s, o)
               where x.s ->> 'id' not like '\_check\_%'), '[]'::jsonb));
  before := (select max(updated_at) from meganet.station where id not like '\_check\_%' and id <> pick);
  perform meganet.load_stations_doc(d);
  got := pg_temp.doc_of(pick);
  perform pg_temp.check_that('load_stations_doc() records the three the document gives',
    (got ->> 'antenna_height_m')::numeric = 9.5 and got -> 'decommissioned' = 'true'::jsonb
      and (got ->> 'decommissioned_year')::integer = 2024, coalesce(got::text, '<missing>'));
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
