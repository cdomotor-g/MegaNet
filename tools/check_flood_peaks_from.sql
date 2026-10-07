-- check_flood_peaks_from.sql — Prove a station taking its flood history from
-- another (0041) against a real database: whose floods it gets, placed how,
-- kept current how, and who may say so.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_flood_peaks_from.sql
--
-- Every check below is one claim the head of 0041_flood_peaks_from.sql makes.
-- It runs inside a transaction and rolls back, so it is safe against the live
-- database. It needs a role meganet.is_editor() says yes to, the stations
-- loaded, and the flood peaks extract loaded (meganet.load_flood_peaks_doc);
-- without Gatton's (40444) peaks it says so and fails, rather than passing on
-- nothing. CI runs it in the db-checks job (.github/workflows/web-smoke.yml).

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

-- A station with no gauge of its own, 190 m from Gatton, as the editor sends it.
create or replace function pg_temp.station(p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
           'id', '_check_fpf', 'name', 'Check Beside Gatton', 'station_number', '',
           'lat', -27.554456, 'lon', 152.274684, 'roles', jsonb_build_array('field'),
           'rm_system_id', -987, 'enabled', true, 'notes', '') || p_extra;
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

insert into meganet.rm_system (id, ord, name)
values (-987, -987, 'check_flood_peaks_from placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_fpf', -987, 'Check Beside Gatton', '', -987, -27.554456, 152.274684, '{field}')
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('fpf-editor@example.test', 'check_flood_peaks_from — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c0f21', 'fpf-editor@example.test', now())
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c0f29"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"fpf-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f21"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

create or replace function pg_temp.editor_saves(p_doc jsonb)
returns void language plpgsql as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"fpf-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f21"}', true);
  perform meganet.save_station(p_doc, (select updated_at from meganet.station where id = p_doc ->> 'id'));
end;
$$;

-- The floods as the document gives them, dates and levels, for comparing.
create or replace function pg_temp.floods(p_id text)
returns jsonb language sql as $$
  select coalesce(pg_temp.doc_of(p_id) -> 'flood_peaks', '[]'::jsonb);
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 41',
    (select value::integer from meganet.app_meta where key = 'schema_version') >= 41);
  perform pg_temp.check_that('Gatton (40444) has its floods — the extract is loaded',
    jsonb_array_length(pg_temp.floods('gatton')) = 5, pg_temp.floods('gatton')::text);
  perform pg_temp.check_that('no station in the register borrows yet — no document gains a key',
    not exists (select 1 from meganet.station_json
                 where (doc ? 'flood_peaks_from' or doc ? 'flood_peaks_gauge') and id not like '\_check\_%'));
  perform pg_temp.check_that('a station with no gauge has no floods',
    jsonb_array_length(pg_temp.floods('_check_fpf')) = 0);
end
$$;

-- ── 2. Who may say so, and what ──────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('an editor may name Gatton',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"flood_peaks_from": "gatton"}'))) = 'ok');
  perform pg_temp.check_that('…not the station itself',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"flood_peaks_from": "_check_fpf"}'))) like '22023%');
  perform pg_temp.check_that('…not a station that is not there',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"flood_peaks_from": "no_such_station"}'))) like '22023%');
  perform pg_temp.check_that('…not a number',
    pg_temp.as_who('editor', pg_temp.save_sql(pg_temp.station('{"flood_peaks_from": 40444}'))) like '22023%');
  perform pg_temp.check_that('a stranger may not',
    pg_temp.as_who('stranger', pg_temp.save_sql(pg_temp.station('{"flood_peaks_from": "gatton"}'))) like '42501%');
  perform pg_temp.check_that('…nor anon',
    pg_temp.as_who('anon', pg_temp.save_sql(pg_temp.station('{"flood_peaks_from": "gatton"}'))) <> 'ok');
  perform pg_temp.check_that('the column''s own check refuses a station naming itself from any other way in',
    pg_temp.refusal_of($q$update meganet.station set flood_peaks_from = id where id = '_check_fpf'$q$) like '23514%');
end
$$;

-- ── 3. Whose floods, placed how ──────────────────────────────────────────────

do $$
declare
  d jsonb;
begin
  perform pg_temp.editor_saves(pg_temp.station('{"flood_peaks_from": "gatton"}'));
  d := pg_temp.doc_of('_check_fpf');
  perform pg_temp.check_that('named, it has Gatton''s five floods, the same dates and levels',
    pg_temp.floods('_check_fpf') = pg_temp.floods('gatton'), pg_temp.floods('_check_fpf')::text);
  perform pg_temp.check_that('…and the document says whose: flood_peaks_from gatton, flood_peaks_gauge 40444',
    d ->> 'flood_peaks_from' = 'gatton' and d ->> 'flood_peaks_gauge' = '40444', d::text);
  perform pg_temp.check_that('Gatton''s own document gains neither key',
    not (pg_temp.doc_of('gatton') ? 'flood_peaks_from') and not (pg_temp.doc_of('gatton') ? 'flood_peaks_gauge'));

  -- A zero of its own that is nothing like Gatton's: the peaks are readings of
  -- Gatton's gauge, so Gatton's zero places them.
  insert into meganet.station_gauge_survey (station_id, ord, gauge_zero_m, datum)
  values ('_check_fpf', 0, 10.0, 'AHD');
  perform pg_temp.check_that('placed through Gatton''s zero, not a zero of the borrower''s own',
    pg_temp.floods('_check_fpf') = pg_temp.floods('gatton'), pg_temp.floods('_check_fpf')::text);

  -- Gatton's zero resurveyed a metre higher: the borrower follows.
  update meganet.station_gauge_survey set gauge_zero_m = gauge_zero_m + 1 where station_id = 'gatton';
  perform pg_temp.check_that('Gatton''s zero moving moves the borrower''s floods with Gatton''s',
    pg_temp.floods('_check_fpf') = pg_temp.floods('gatton')
    and (pg_temp.floods('gatton') -> 0 ->> 'level_m_ahd')::numeric = 104.87, pg_temp.floods('_check_fpf')::text);
  update meganet.station_gauge_survey set gauge_zero_m = gauge_zero_m - 1 where station_id = 'gatton';

  perform pg_temp.editor_saves(pg_temp.doc_of('_check_fpf') || '{"notes": "saved as loaded"}'::jsonb);
  perform pg_temp.check_that('a save of the document as loaded keeps the link and the floods',
    pg_temp.doc_of('_check_fpf') ->> 'flood_peaks_from' = 'gatton'
    and jsonb_array_length(pg_temp.floods('_check_fpf')) = 5);

  -- Gatton deleted: nothing to take from.
  update meganet.station set deleted_at = now() where id = 'gatton';
  perform pg_temp.check_that('with Gatton deleted, the borrower has no floods',
    jsonb_array_length(pg_temp.floods('_check_fpf')) = 0);
  update meganet.station set deleted_at = null where id = 'gatton';
  perform pg_temp.check_that('…and restored, it has them back',
    jsonb_array_length(pg_temp.floods('_check_fpf')) = 5);

  perform pg_temp.editor_saves(pg_temp.doc_of('_check_fpf') - 'flood_peaks_from');
  d := pg_temp.doc_of('_check_fpf');
  perform pg_temp.check_that('a save without the key unlinks it: no floods, neither key',
    jsonb_array_length(pg_temp.floods('_check_fpf')) = 0 and not (d ? 'flood_peaks_from') and not (d ? 'flood_peaks_gauge'),
    d::text);
end
$$;

-- ── 4. A gauge of its own wins ───────────────────────────────────────────────

do $$
declare
  own  text := (select t.station_id from meganet.station_flood_peak_top t
                 where t.station_id not in ('gatton') and t.station_id not like '\_check\_%'
                 group by t.station_id having count(*) = 5 order by t.station_id limit 1);
  was  jsonb := pg_temp.floods(own);
begin
  update meganet.station set flood_peaks_from = 'gatton' where id = own;
  perform pg_temp.check_that('a station with a gauge of its own that names Gatton keeps its own floods',
    pg_temp.floods(own) = was and not (pg_temp.doc_of(own) ? 'flood_peaks_gauge'), coalesce(own, '<none>'));
end
$$;

-- ── 5. The loader ────────────────────────────────────────────────────────────

do $$
declare
  d      jsonb := meganet.stations_doc();
  before timestamptz;
  pick   text := (select id from meganet.station s where id not like '\_check\_%' and deleted_at is null
                     and not exists (select 1 from meganet.flood_peak_gauge g
                                      where meganet.bureau_key(g.bureau_number) = meganet.bureau_key(s.station_number))
                   order by ord limit 1);
  got    jsonb;
begin
  update meganet.station set flood_peaks_from = null where flood_peaks_from is not null;
  d := meganet.stations_doc();
  d := jsonb_set(d, '{stations}',
    coalesce((select jsonb_agg(case when x.s ->> 'id' = pick then x.s || '{"flood_peaks_from": "gatton"}'::jsonb else x.s end order by x.o)
                from jsonb_array_elements(d -> 'stations') with ordinality x(s, o)
               where x.s ->> 'id' not like '\_check\_%'), '[]'::jsonb));
  before := (select max(updated_at) from meganet.station where id not like '\_check\_%' and id <> pick);
  perform meganet.load_stations_doc(d);
  got := pg_temp.doc_of(pick);
  perform pg_temp.check_that('load_stations_doc() records a link the document gives, and the floods follow',
    got ->> 'flood_peaks_from' = 'gatton' and pg_temp.floods(pick) = pg_temp.floods('gatton'),
    coalesce(got::text, '<missing>'));
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
