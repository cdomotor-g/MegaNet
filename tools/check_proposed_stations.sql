-- check_proposed_stations.sql — Prove the proposed stations (0039) against a
-- real database: what a proposal is, what the station document says of it,
-- and who may propose, add and establish a station.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_proposed_stations.sql
--
-- Every check below is one claim the head of 0039_proposed_stations.sql makes,
-- or one rule save_station() enforces. The whole script runs inside a
-- transaction and rolls back, so it is safe against the live database:
-- nothing it writes survives — the stations it proposes, adds and establishes,
-- and the three people it signs in as (one of them made an administrator).
--
-- It needs to be run as a role meganet.is_editor() and meganet.is_admin() say
-- yes to — a direct psql connection, or one holding the service key. It prints
-- a row per check and exits non-zero if any of them failed. CI runs it in the
-- db-checks job after every migration has been applied from zero and
-- stations.json loaded (.github/workflows/web-smoke.yml).
--
-- What it deliberately does not check: the browser's half — the editor's
-- Proposed box, the card's banner, the hollow pin — which is test/proposed.mjs's.

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

-- A proposal, as the editor would send it, over any of its fields.
create or replace function pg_temp.proposal(p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
           'id', '_check_prop_a', 'name', 'Check Proposed Creek', 'station_number', '',
           'lat', -31.51, 'lon', 161.01, 'roles', jsonb_build_array('field'),
           'rm_system_id', -989, 'enabled', true, 'notes', '',
           'proposed', true, 'station_type', 'auto_rain_gauge', 'proposed_year', 2026) || p_extra;
$$;

-- save_station() on a document, as SQL text for as_role().
create or replace function pg_temp.save_sql(p_doc jsonb, p_stamp timestamptz default null)
returns text language sql as $$
  select pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)', p_doc, p_stamp);
$$;

create or replace function pg_temp.stamp(p_id text)
returns timestamptz language sql as $$
  select updated_at from meganet.station where id = p_id;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- A radio system, an established station in the Tasman Sea, and three people —
-- an editor, an administrator, a stranger — signed up the way the signup
-- triggers (0005) provision them.

insert into meganet.rm_system (id, ord, name)
values (-989, -989, 'check_proposed_stations placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_prop_est', -989, 'Check Established', '998390', -989, -31.6, 161.1, '{field}')
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('proposed-editor@example.test', 'check_proposed_stations — rolled back'),
  ('proposed-admin@example.test',  'check_proposed_stations — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c0f01', 'proposed-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000c0f02', 'proposed-admin@example.test', now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000c0f02';

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c0f09"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"proposed-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f01"}'),
  ('admin',    'authenticated', '{"role":"authenticated","email":"proposed-admin@example.test","sub":"00000000-0000-4000-8000-0000000c0f02"}'),
  ('service',  'service_role',  '{"role":"service_role"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 39',
    (select value::integer >= 39 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('the four station types, in the order they are offered',
    (select array_agg(code order by ord) = array['auto_water_level', 'auto_rain_gauge',
                                                 'manual_water_level', 'manual_rain_gauge']
       from meganet.station_type));

  perform pg_temp.check_that('meganet.station_type has RLS on',
    (select relrowsecurity from pg_catalog.pg_class where oid = 'meganet.station_type'::regclass),
    'db/README.md: no table without RLS, in the same file');

  perform pg_temp.check_that('every station already here is established: none is proposed',
    not exists (select 1 from meganet.station where proposed and id not like '\_check\_%'));

  perform pg_temp.check_that('and the station document gained nothing: no station carries the three keys',
    not exists (select 1 from meganet.station_json
                 where doc ?| array['proposed', 'station_type', 'proposed_year']));

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('the vocabulary is anybody''s to read, and nobody''s in a browser to write',
      has_table_privilege('anon', 'meganet.station_type', 'select')
      and has_table_privilege('authenticated', 'meganet.station_type', 'select')
      and not has_table_privilege('authenticated', 'meganet.station_type', 'insert'));
  end if;
end
$$;

-- ── 2. An editor proposes ────────────────────────────────────────────────────

do $$
declare
  v text;
begin
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal()));
  perform pg_temp.check_that('an editor may propose a station — a name, a type, a year and a place, and no number', v = 'ok', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed": false}')));
  perform pg_temp.check_that('…and may not add one outright: refused, and said to be an administrator''s',
    v = '42501/administrator', v);

  v := pg_temp.as_who('stranger', pg_temp.save_sql(pg_temp.proposal()));
  perform pg_temp.check_that('somebody not on the editors list may not propose one either', v like '42501%' and v <> '42501/administrator', v);

  v := pg_temp.as_who('anon', pg_temp.save_sql(pg_temp.proposal()));
  perform pg_temp.check_that('nor may anybody signed out', v <> 'ok', v);

  v := pg_temp.as_who('admin', pg_temp.save_sql(pg_temp.proposal('{"id": "_check_prop_new", "proposed": false}')));
  perform pg_temp.check_that('an administrator may add a station outright', v = 'ok', v);

  v := pg_temp.as_who('service', pg_temp.save_sql(pg_temp.proposal('{"id": "_check_prop_svc", "proposed": false}')));
  perform pg_temp.check_that('…and so may the service role', v = 'ok', v);

  -- What a proposal has to say, each asked in words.
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal() - 'station_type'));
  perform pg_temp.check_that('a proposal without its type is refused', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal() - 'proposed_year'));
  perform pg_temp.check_that('…without its year', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"lat": null}')));
  perform pg_temp.check_that('…without a place', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"station_type": "tide_gauge"}')));
  perform pg_temp.check_that('…with a type nobody knows', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed_year": 1850}')));
  perform pg_temp.check_that('…for a year before 1900', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed_year": "next year"}')));
  perform pg_temp.check_that('…for a year that is not one', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed": "yes"}')));
  perform pg_temp.check_that('…and proposed has to be true or false', v = '22023', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed_year": 2019}')));
  perform pg_temp.check_that('a proposal may be dated back', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed_year": 2031}')));
  perform pg_temp.check_that('…or forward', v = 'ok', v);
end
$$;

-- ── 3. What the register and the document say of a proposal ─────────────────
-- Saved as the connection running this, which is an administrator, so the
-- rest of the checks have one to work on.

do $$ begin perform meganet.save_station(pg_temp.proposal(), null); end $$;

do $$
declare
  d jsonb := (select doc from meganet.station_json where id = '_check_prop_a');
begin
  perform pg_temp.check_that('the document says proposed, the type and the year',
    d -> 'proposed' = 'true'::jsonb and d ->> 'station_type' = 'auto_rain_gauge'
    and (d -> 'proposed_year') = '2026'::jsonb, d::text);
  perform pg_temp.check_that('…and no station number, which it does not have yet', d ->> 'station_number' = '', d ->> 'station_number');
  perform pg_temp.check_that('the established station beside it carries none of the three keys',
    not ((select doc from meganet.station_json where id = '_check_prop_est') ?| array['proposed', 'station_type', 'proposed_year']));
  perform pg_temp.check_that('a proposal with no type cannot be written round save_station() either',
    pg_temp.refusal_of($q$update meganet.station set station_type = null where id = '_check_prop_a'$q$) like '23514%');
  perform pg_temp.check_that('…nor one with no place',
    pg_temp.refusal_of($q$update meganet.station set lat = null where id = '_check_prop_a'$q$) like '23514%');
  perform pg_temp.check_that('…nor a year of 3000 on any station',
    pg_temp.refusal_of($q$update meganet.station set proposed_year = 3000 where id = '_check_prop_est'$q$) like '23514%');
end
$$;

-- ── 4. Editing, establishing, and taking back ───────────────────────────────

do $$
declare
  v text;
  st timestamptz := pg_temp.stamp('_check_prop_a');
  se timestamptz := pg_temp.stamp('_check_prop_est');
begin
  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"name": "Check Proposed Gully", "proposed_year": 2028}'), st));
  perform pg_temp.check_that('an editor may edit a proposal — its name, its year', v = 'ok', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed": false, "station_number": "998391"}'), st));
  perform pg_temp.check_that('…and may not establish it', v = '42501/administrator', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(
         (select doc from meganet.station_json where id = '_check_prop_est') || '{"notes": "checked"}', se));
  perform pg_temp.check_that('an editor still edits an established station as before', v = 'ok', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(
         (select doc from meganet.station_json where id = '_check_prop_est')
           || '{"proposed": true, "station_type": "manual_rain_gauge", "proposed_year": 2027}', se));
  perform pg_temp.check_that('…and may not take it back to proposed', v = '42501/administrator', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(
         (select doc from meganet.station_json where id = '_check_prop_est') || '{"station_type": "manual_water_level"}', se));
  perform pg_temp.check_that('an established station may be given a type by an editor', v = 'ok', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal(), st - interval '1 second'));
  perform pg_temp.check_that('a stale tab hears it is stale before it hears who may do what',
    v = 'PT409', v);

  v := pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.proposal('{"proposed": false}'), null));
  perform pg_temp.check_that('…and so does one that did not load it', v = 'PT409', v);

  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.delete_station(%L, %L::timestamptz)', '_check_prop_a', st));
  perform pg_temp.check_that('an editor may withdraw a proposal — a delete, as for any station', v = 'ok', v);

  v := pg_temp.as_who('admin', pg_temp.save_sql(pg_temp.proposal('{"proposed": false, "station_number": "998391"}'), st));
  perform pg_temp.check_that('an administrator may establish it', v = 'ok', v);

  v := pg_temp.as_who('admin', pg_temp.save_sql(
         (select doc from meganet.station_json where id = '_check_prop_est')
           || '{"proposed": true, "station_type": "manual_rain_gauge", "proposed_year": 2027}', se));
  perform pg_temp.check_that('…and may take an established station back to proposed', v = 'ok', v);
end
$$;

-- Established, as the administrator would: the document's flag goes, and the
-- type and the year stay as the record of what was proposed.
do $$
begin
  perform meganet.save_station(pg_temp.proposal('{"proposed": false, "station_number": "998391"}'),
                               pg_temp.stamp('_check_prop_a'));
end
$$;

do $$
declare
  d jsonb := (select doc from meganet.station_json where id = '_check_prop_a');
begin
  perform pg_temp.check_that('established: no proposed key, the number it was given, the type and the year kept',
    not (d ? 'proposed') and d ->> 'station_number' = '998391'
    and d ->> 'station_type' = 'auto_rain_gauge' and d -> 'proposed_year' = '2026'::jsonb, d::text);
end
$$;

-- ── 5. The loader ────────────────────────────────────────────────────────────
-- The whole register back through load_stations_doc() with one proposal added
-- at the end: the proposal arrives whole, and nothing else changes. This
-- script's own stations are left out of the document — their places at its
-- head would move every other station down one and rewrite them all — and go
-- with the sync. The placeholder radio system is in the document already:
-- stations_doc() reads it off the table.

do $$
declare
  d      jsonb := meganet.stations_doc();
  before timestamptz := (select max(updated_at) from meganet.station where id not like '\_check\_%');
  frag   jsonb := jsonb_build_object('id', '_check_prop_load', 'name', 'Check Loaded Proposal',
                    'station_number', '', 'lat', -31.7, 'lon', 161.2, 'elevation_ahd', null,
                    'roles', jsonb_build_array('field'), 'radio_network_ids', '[]'::jsonb,
                    'catchment_ids', '[]'::jsonb, 'alert_ids', '{}'::jsonb,
                    'satcom', jsonb_build_object('enabled', false, 'provider', '', 'terminal_id', ''),
                    'rm_system_id', -989, 'enabled', true, 'notes', '',
                    'proposed', true, 'station_type', 'manual_water_level', 'proposed_year', 2030);
  got    jsonb;
begin
  perform meganet.load_stations_doc(jsonb_set(d, '{stations}',
    coalesce((select jsonb_agg(x.s order by x.o)
                from jsonb_array_elements(d -> 'stations') with ordinality x(s, o)
               where x.s ->> 'id' not like '\_check\_%'), '[]'::jsonb)
    || jsonb_build_array(frag)));
  got := (select doc from meganet.station_json where id = '_check_prop_load');
  perform pg_temp.check_that('load_stations_doc() loads a proposal whole',
    got -> 'proposed' = 'true'::jsonb and got ->> 'station_type' = 'manual_water_level'
    and got -> 'proposed_year' = '2030'::jsonb, coalesce(got::text, '<missing>'));
  perform pg_temp.check_that('…and rewrites no station it already had',
    (select max(updated_at) from meganet.station where id not like '\_check\_%') = before);
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
