-- check_level_surveys.sql — Prove the level surveys (0060) against a real
-- database: who may file a survey, a two-peg test, a level or a picture; what
-- the database works out for itself (a test's error and pass, a survey's ΣBS,
-- ΣFS and misclose); and that only an administrator changes a station from a
-- survey — or changes its gauge zero at all.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_level_surveys.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database: the
-- station, the people (one made an administrator), the surveys and what was
-- applied from them all go. Run it as a role is_editor() and is_admin() say
-- yes to — a direct psql connection, or the service key. CI runs it in the
-- db-checks job after every migration has been applied from zero.
--
-- What it deliberately does not check: the sheet's own arithmetic — the rows'
-- shape, rise and fall, the datums, the boards, the water check — which is
-- levelling.js's, held by test/levels.mjs.

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
-- A station in the Tasman Sea with a gauge zero since 2018, and five people:
-- two editors, an administrator, a stranger, and nobody signed in.

insert into meganet.rm_system (id, ord, name)
values (-987, -987, 'check_level_surveys placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_lvl_stn', -987, 'Check Level Creek', '998701', -987, -31.7, 161.2, '{field}')
on conflict (id) do nothing;

insert into meganet.station_gauge_survey (station_id, ord, valid_from, gauge_zero_m, datum, amtd_km, catchment_area_km2, note)
values ('_check_lvl_stn', 0, '2018-01-01', 10.00, 'AHD', 12.3, 456, 'check fixture')
on conflict do nothing;

insert into meganet.editor_allow (entry, note) values
  ('lvl-editor@example.test', 'check_level_surveys — rolled back'),
  ('lvl-other@example.test',  'check_level_surveys — rolled back'),
  ('lvl-admin@example.test',  'check_level_surveys — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000e6001', 'lvl-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000e6002', 'lvl-other@example.test', now()),
  ('00000000-0000-4000-8000-0000000e6003', 'lvl-admin@example.test', now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000e6003';

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000e6009"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"lvl-editor@example.test","sub":"00000000-0000-4000-8000-0000000e6001"}'),
  ('other',    'authenticated', '{"role":"authenticated","email":"lvl-other@example.test","sub":"00000000-0000-4000-8000-0000000e6002"}'),
  ('admin',    'authenticated', '{"role":"authenticated","email":"lvl-admin@example.test","sub":"00000000-0000-4000-8000-0000000e6003"}'),
  ('service',  'service_role',  '{"role":"service_role"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.keep_as(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role_keep(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- Documents, as the tabs send them.
create or replace function pg_temp.test_doc(p_id text, p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'type', 'two-peg', 'v', 1, 'practice', false, 'date', '2026-07-10',
                            'tester', 'A. Tester', 'organisation', 'Check crew',
                            'instrument', jsonb_build_object('id', null, 'make', 'Check', 'model', 'L1', 'serial', 'CHK-1'),
                            'spacing', 50, 'near', 5, 'a1', 1.200, 'b1', 1.300, 'a2', 1.500, 'b2', 1.602, 'tol', 0.003,
                            'sync', jsonb_build_object('state', 'waiting')) || p_extra;
$$;

-- A closed run: BS 1.412 + 0.774 + 3.488 = 5.674, FS 3.020 + 1.105 + 1.548 = 5.673.
create or replace function pg_temp.survey_doc(p_id text, p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'type', 'level-survey', 'v', 1, 'practice', false, 'date', '2026-07-12',
           'station', jsonb_build_object('id', '_check_lvl_stn', 'number', '998701', 'name', 'Check Level Creek'),
           'datum', 'AHD', 'bm', jsonb_build_object('name', 'BM998701_1', 'rl', 31.25),
           'tol', jsonb_build_object('misclose', 0.003),
           'rows', jsonb_build_array(
             jsonb_build_object('id', 'r1', 'kind', 'bm', 'bs', 1.412),
             jsonb_build_object('id', 'r2', 'kind', 'board', 'is', 1.866, 'face', 4),
             jsonb_build_object('id', 'r3', 'kind', 'cp', 'fs', 3.020, 'bs', 0.774),
             jsonb_build_object('id', 'r4', 'kind', 'ctr', 'is', '3.329'),
             jsonb_build_object('id', 'r5', 'kind', 'cp', 'fs', 1.105, 'bs', 3.488),
             jsonb_build_object('id', 'r6', 'kind', 'bm', 'fs', 1.548)),
           'result', jsonb_build_object('closed', true, 'misclose', 0.001, 'within', true, 'gauge_zero', 26.8),
           'sync', jsonb_build_object('state', 'waiting')) || p_extra;
$$;

create or replace function pg_temp.save_survey_sql(p_doc jsonb)
returns text language sql as $$ select pg_catalog.format('select meganet.level_survey_save(%L::jsonb)::text', p_doc) $$;
create or replace function pg_temp.save_test_sql(p_doc jsonb)
returns text language sql as $$ select pg_catalog.format('select meganet.two_peg_test_save(%L::jsonb)::text', p_doc) $$;
create or replace function pg_temp.apply_sql(p_id text, p_changes jsonb, p_note text default null)
returns text language sql as $$
  select pg_catalog.format('select meganet.level_survey_apply(%L::uuid, %L::jsonb, %L)::text', p_id, p_changes, p_note)
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 60',
    (select value::integer >= 60 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('the seven tables are there, every one with RLS on',
    (select count(*) = 7 and bool_and(c.relrowsecurity) from pg_catalog.pg_class c
      where c.oid in ('meganet.level_equipment'::regclass, 'meganet.two_peg_test'::regclass, 'meganet.level_survey'::regclass,
                      'meganet.level_evidence'::regclass, 'meganet.station_level_point'::regclass,
                      'meganet.station_level_offset'::regclass, 'meganet.level_survey_decision'::regclass)),
    'db/README.md: no table without RLS, in the same file');

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('nobody signed out reads a survey, and no browser role writes one directly',
      not has_table_privilege('anon', 'meganet.level_survey', 'select')
      and has_table_privilege('authenticated', 'meganet.level_survey', 'select')
      and not has_table_privilege('authenticated', 'meganet.level_survey', 'insert')
      and not has_table_privilege('authenticated', 'meganet.station_level_point', 'update'));
    perform pg_temp.check_that('…and nobody signed out may run the doors in',
      not has_function_privilege('anon', 'meganet.level_survey_save(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.level_survey_apply(uuid, jsonb, text)', 'execute'));
  end if;

  perform pg_temp.check_that('level_num reads a JSON number and a string holding one, and nothing else',
    meganet.level_num('1.245'::jsonb) = 1.245 and meganet.level_num('" 2.5 "'::jsonb) = 2.5
    and meganet.level_num('"1.2.3"'::jsonb) is null and meganet.level_num('true'::jsonb) is null
    and meganet.level_num(null) is null);
end
$$;

-- ── 2. The equipment ─────────────────────────────────────────────────────────

do $$
declare
  v text;
  j jsonb;
begin
  v := pg_temp.as_who('editor', 'select meganet.level_equipment_save(''{"id":"8f6a3b1e-0000-4000-8000-000000000001","kind":"level","make":"Check","model":"L1","serial":"CHK-1","service_date":"2026-06-15"}''::jsonb)');
  perform pg_temp.check_that('an editor keeps a level', v = 'ok', v);
  v := pg_temp.as_who('stranger', 'select meganet.level_equipment_save(''{"id":"8f6a3b1e-0000-4000-8000-000000000001","make":"Check","serial":"CHK-1"}''::jsonb)');
  perform pg_temp.check_that('somebody not on the editors list may not', v like '42501%', v);
  v := pg_temp.as_who('anon', 'select meganet.level_equipment_save(''{"id":"8f6a3b1e-0000-4000-8000-000000000001","make":"Check","serial":"CHK-1"}''::jsonb)');
  perform pg_temp.check_that('…nor anybody signed out', v <> 'ok', v);
  v := pg_temp.as_who('editor', 'select meganet.level_equipment_save(''{"id":"8f6a3b1e-0000-4000-8000-000000000001","colour":"yellow"}''::jsonb)');
  perform pg_temp.check_that('a key the register does not keep is refused', v = '22023', v);

  j := pg_temp.keep_as('editor', 'select meganet.level_equipment_save(''{"id":"8f6a3b1e-0000-4000-8000-000000000001","kind":"level","make":"Check","model":"L1","serial":"CHK-1","service_date":"2026-06-15"}''::jsonb)::text')::jsonb;
  perform pg_temp.check_that('the level is kept, attributed to the editor',
    j #>> '{equipment,serial}' = 'CHK-1' and j #>> '{equipment,created_by}' = 'lvl-editor@example.test', j::text);
  j := pg_temp.keep_as('other', 'select meganet.level_equipment_save(''{"id":"8f6a3b1e-0000-4000-8000-000000000002","kind":"level","make":"check","model":"L1","serial":"chk-1"}''::jsonb)::text')::jsonb;
  perform pg_temp.check_that('the same unit entered on another phone is answered with the one already kept',
    j ->> 'duplicate_of' = '8f6a3b1e-0000-4000-8000-000000000001'
    and not exists (select 1 from meganet.level_equipment where id = '8f6a3b1e-0000-4000-8000-000000000002'), j::text);
end
$$;

-- ── 3. Two-peg tests ─────────────────────────────────────────────────────────

do $$
declare
  v text;
  t meganet.two_peg_test%rowtype;
begin
  perform pg_temp.keep_as('editor', pg_temp.save_test_sql(pg_temp.test_doc('7a2c0d9e-0000-4000-8000-000000000001',
    '{"instrument":{"id":"8f6a3b1e-0000-4000-8000-000000000001","make":"Check","model":"L1","serial":"CHK-1"}}')));
  select * into t from meganet.two_peg_test where id = '7a2c0d9e-0000-4000-8000-000000000001';
  perform pg_temp.check_that('a two-peg test is filed: 1.200/1.300 then 1.500/1.602 is an error of 0.002 m, and passes',
    t.error_m = 0.002 and t.passed and t.submitted_by = 'lvl-editor@example.test', pg_catalog.format('%s %s', t.error_m, t.passed));
  perform pg_temp.check_that('…filed under the level it tested, and without the phone''s bookkeeping',
    t.equipment_id = '8f6a3b1e-0000-4000-8000-000000000001' and not (t.doc ? 'sync'));

  perform pg_temp.keep_as('editor', pg_temp.save_test_sql(pg_temp.test_doc('7a2c0d9e-0000-4000-8000-000000000002', '{"b2": 1.604}')));
  select * into t from meganet.two_peg_test where id = '7a2c0d9e-0000-4000-8000-000000000002';
  perform pg_temp.check_that('an error of 0.004 m against 0.003 m fails — worked out here, whatever the phone said',
    t.error_m = 0.004 and not t.passed, pg_catalog.format('%s %s', t.error_m, t.passed));

  v := pg_temp.as_who('editor', pg_temp.save_test_sql(pg_temp.test_doc('7a2c0d9e-0000-4000-8000-000000000003', '{"practice": true}')));
  perform pg_temp.check_that('a practice test stays on the device', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_test_sql(pg_temp.test_doc('7a2c0d9e-0000-4000-8000-000000000003') - 'b2'));
  perform pg_temp.check_that('a test missing a reading is refused', v = '22023', v);
  v := pg_temp.as_who('other', pg_temp.save_test_sql(pg_temp.test_doc('7a2c0d9e-0000-4000-8000-000000000001', '{"a1": 1.201}')));
  perform pg_temp.check_that('another editor may not change somebody''s test', v = '42501', v);
  v := pg_temp.as_who('admin', pg_temp.save_test_sql(pg_temp.test_doc('7a2c0d9e-0000-4000-8000-000000000001', '{"a1": 1.200}')));
  perform pg_temp.check_that('…an administrator may', v = 'ok', v);
end
$$;

-- ── 4. Level surveys ─────────────────────────────────────────────────────────

do $$
declare
  v text;
  s meganet.level_survey%rowtype;
begin
  perform pg_temp.keep_as('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000001',
    '{"peg_test":{"id":"7a2c0d9e-0000-4000-8000-000000000001"},"instrument":{"id":"8f6a3b1e-0000-4000-8000-000000000001"}}')));
  select * into s from meganet.level_survey where id = '5b1e7c2a-0000-4000-8000-000000000001';
  perform pg_temp.check_that('a closed survey is filed, its sums worked out here from its rows (a reading sent as text counted too)',
    s.sum_bs = 5.674 and s.sum_fs = 5.673 and s.rows_n = 6 and s.misclose_m = 0.001 and s.outcome = 'pass'
    and s.status = 'submitted' and s.submitted_by = 'lvl-editor@example.test',
    pg_catalog.format('%s %s %s %s %s', s.sum_bs, s.sum_fs, s.misclose_m, s.outcome, s.status));
  perform pg_temp.check_that('…under its station, its level and its two-peg test',
    s.station_id = '_check_lvl_stn' and s.equipment_id = '8f6a3b1e-0000-4000-8000-000000000001'
    and s.two_peg_test_id = '7a2c0d9e-0000-4000-8000-000000000001' and s.bm_name = 'BM998701_1' and s.gauge_zero_rl = 26.8);

  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000002',
    '{"result":{"closed":true,"misclose":0.000}}')));
  perform pg_temp.check_that('a survey whose misclose is not what its readings give is refused', v = '22023', v);

  perform pg_temp.keep_as('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000003',
    '{"tol":{"misclose":0.0005},"result":{"closed":true,"misclose":0.001}}')));
  perform pg_temp.check_that('a closed survey outside its tolerance is filed as a fail — kept, not refused',
    (select outcome = 'fail' from meganet.level_survey where id = '5b1e7c2a-0000-4000-8000-000000000003'));

  perform pg_temp.keep_as('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000004',
    '{"result":{"closed":false}}')));
  perform pg_temp.check_that('a survey that has not closed is filed as open, with no misclose',
    (select outcome = 'open' and misclose_m is null from meganet.level_survey where id = '5b1e7c2a-0000-4000-8000-000000000004'));

  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000005', '{"practice": true}')));
  perform pg_temp.check_that('a practice survey stays on the device', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000005',
    '{"station":{"id":null,"number":"","name":""}}')));
  perform pg_temp.check_that('a survey of no station is refused', v = '22023', v);
  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000005',
    '{"station":{"id":"_check_no_such_station"}}')));
  perform pg_temp.check_that('…and of a station Flood-Net does not have', v = '23503', v);
  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000005', '{"datum":"GDA"}')));
  perform pg_temp.check_that('a survey''s datum is AHD, assumed or the gauge''s', v = '22023', v);
  v := pg_temp.as_who('other', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000001')));
  perform pg_temp.check_that('another editor may not change somebody''s survey', v = '42501', v);
  v := pg_temp.as_who('stranger', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000006')));
  perform pg_temp.check_that('somebody not on the editors list may not file one', v like '42501%', v);
  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000001', '{"notes":"corrected"}')));
  perform pg_temp.check_that('its own crew may send it again while it waits', v = 'ok', v);
end
$$;

-- ── 5. The pictures ──────────────────────────────────────────────────────────

do $$
declare
  v text;
  ok_doc jsonb := jsonb_build_object(
    'id', '3c9d2e4f-0000-4000-8000-000000000001', 'owner', 'survey', 'owner_id', '5b1e7c2a-0000-4000-8000-000000000001',
    'row_id', 'r2', 'field', 'is', 'kind', 'reading',
    'storage_path', 'survey/5b1e7c2a-0000-4000-8000-000000000001/3c9d2e4f-0000-4000-8000-000000000001.webp',
    'content_type', 'image/webp', 'byte_size', 21500, 'width', 640, 'height', 220, 'ocr_text', '1.866', 'value_m', 1.866,
    'taken_at', '2026-07-12T00:35:00Z', 'lat', -31.7, 'lon', 161.2, 'accuracy_m', 4);
begin
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.level_evidence_add(%L::jsonb)', ok_doc || '{"storage_path":"survey/x.webp"}'));
  perform pg_temp.check_that('a picture is filed at its own path or not at all', v = '22023', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.level_evidence_add(%L::jsonb)', ok_doc || '{"content_type":"image/gif"}'));
  perform pg_temp.check_that('…as WebP, JPEG or PNG', v = '22023', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.level_evidence_add(%L::jsonb)',
    ok_doc || '{"owner_id":"5b1e7c2a-0000-4000-8000-0000000000ff","storage_path":"survey/5b1e7c2a-0000-4000-8000-0000000000ff/3c9d2e4f-0000-4000-8000-000000000001.webp"}'));
  perform pg_temp.check_that('…under a survey that has been filed', v = '23503', v);
  v := pg_temp.as_who('other', pg_catalog.format('select meganet.level_evidence_add(%L::jsonb)', ok_doc));
  perform pg_temp.check_that('…by its own crew', v = '42501', v);
  perform pg_temp.keep_as('editor', pg_catalog.format('select meganet.level_evidence_add(%L::jsonb)::text', ok_doc));
  perform pg_temp.keep_as('editor', pg_catalog.format('select meganet.level_evidence_add(%L::jsonb)::text', ok_doc));
  perform pg_temp.check_that('a reading''s picture is filed with what was read and the value taken — once, however often it is sent',
    (select count(*) = 1 and bool_and(value_m = 1.866 and ocr_text = '1.866' and row_id = 'r2' and field = 'is')
       from meganet.level_evidence where survey_id = '5b1e7c2a-0000-4000-8000-000000000001'));
end
$$;

-- ── 6. Only an administrator changes the station ─────────────────────────────

do $$
declare
  v text;
  j jsonb;
  g meganet.station_gauge_survey%rowtype;
  stamp timestamptz := (select updated_at from meganet.station where id = '_check_lvl_stn');
  v_changes jsonb := jsonb_build_array(
    jsonb_build_object('key', 'gauge_zero', 'kind', 'gauge_zero',
                       'value', jsonb_build_object('gauge_zero_m', 26.8, 'datum', 'AHD', 'valid_from', '2026-07-12')),
    jsonb_build_object('key', 'bm:BM998701_1', 'kind', 'point',
                       'value', jsonb_build_object('kind', 'bm', 'name', 'BM998701_1', 'primary', true, 'rl', 31.25, 'datum', 'AHD',
                                                   'rl_lgh', 4.45, 'description', 'pin in the headwall')),
    jsonb_build_object('key', 'ctr:CTR', 'kind', 'point',
                       'value', jsonb_build_object('kind', 'ctr', 'name', 'CTR', 'rl', 27.087, 'datum', 'AHD', 'rl_lgh', 0.287)),
    jsonb_build_object('key', 'offset', 'kind', 'offset',
                       'value', jsonb_build_object('correction_m', 0.004, 'note', 'water check 09:42')));
begin
  v := pg_temp.as_who('editor', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000001', v_changes));
  perform pg_temp.check_that('an editor may not apply a survey to its station — not even their own', v = '42501/administrator', v);
  v := pg_temp.as_who('admin', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000001', '[]'));
  perform pg_temp.check_that('applying nothing is refused', v = '22023', v);
  v := pg_temp.as_who('admin', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000001',
    '[{"key":"x","kind":"gauge_zero","value":{"gauge_zero_m":26.8,"datum":"ASSUMED","valid_from":"2026-07-12"}}]'));
  perform pg_temp.check_that('a gauge zero''s datum is one the gauge survey list knows', v = '22023', v);

  j := pg_temp.keep_as('admin', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000001', v_changes, 'checked against the site pack'))::jsonb;
  perform pg_temp.check_that('an administrator applies it: the survey is applied, by them',
    j #>> '{survey,status}' = 'applied' and j #>> '{survey,decided_by}' = 'lvl-admin@example.test', j::text);

  select * into g from meganet.station_gauge_survey where station_id = '_check_lvl_stn' and valid_from = '2026-07-12';
  perform pg_temp.check_that('the new gauge zero opens on the survey''s date, its AMTD and catchment carried forward',
    g.gauge_zero_m = 26.8 and g.datum = 'AHD' and g.valid_to is null and g.amtd_km = 12.3 and g.catchment_area_km2 = 456
    and g.updated_by = 'lvl-admin@example.test', pg_catalog.format('%s %s %s %s', g.gauge_zero_m, g.datum, g.amtd_km, g.updated_by));
  perform pg_temp.check_that('…and the one before it closes the day before',
    (select valid_to = '2026-07-11' from meganet.station_gauge_survey where station_id = '_check_lvl_stn' and valid_from = '2018-01-01'));
  perform pg_temp.check_that('…the station document says so',
    (select doc -> 'gauge_survey' @> '[{"valid_from":"2026-07-12","gauge_zero_m":26.8,"datum":"AHD"}]'::jsonb
       from meganet.station_json where id = '_check_lvl_stn'));
  perform pg_temp.check_that('…and the station''s stamp moved, so an editor who had it open reloads first',
    (select updated_at > stamp or updated_by = 'lvl-admin@example.test' from meganet.station where id = '_check_lvl_stn'));
  perform pg_temp.check_that('the benchmark and the CTR are the station''s now, the benchmark primary',
    (select count(*) = 2 from meganet.station_level_point where station_id = '_check_lvl_stn' and superseded_at is null)
    and (select is_primary and rl = 31.25 and survey_id = '5b1e7c2a-0000-4000-8000-000000000001'
           from meganet.station_level_point where station_id = '_check_lvl_stn' and kind = 'bm' and superseded_at is null));
  perform pg_temp.check_that('the offset correction is recorded from the survey''s date',
    (select correction_m = 0.004 and valid_from = '2026-07-12' from meganet.station_level_offset where station_id = '_check_lvl_stn'));
  perform pg_temp.check_that('the decision keeps each change''s before and after',
    (select jsonb_array_length(changes) = 4
            and changes -> 0 -> 'before' ->> 'gauge_zero_m' = '10.00'
            and changes -> 0 -> 'after' ->> 'gauge_zero_m' = '26.8'
            and note = 'checked against the site pack'
       from meganet.level_survey_decision where survey_id = '5b1e7c2a-0000-4000-8000-000000000001'));

  v := pg_temp.as_who('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000001')));
  perform pg_temp.check_that('an applied survey is a record: its crew may not change it', v = '55000', v);

  -- A second survey supersedes the CTR, and may not go behind the new gauge zero.
  perform pg_temp.keep_as('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000007', '{"date":"2026-05-01"}')));
  v := pg_temp.as_who('admin', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000007',
    '[{"key":"g","kind":"gauge_zero","value":{"gauge_zero_m":26.7,"datum":"AHD","valid_from":"2026-05-01"}}]'));
  perform pg_temp.check_that('a gauge zero from before the station''s latest is refused', v = '22023', v);
  perform pg_temp.keep_as('admin', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000007',
    '[{"key":"c","kind":"point","value":{"kind":"ctr","name":"ctr","rl":27.09,"datum":"AHD","rl_lgh":0.29}}]'));
  perform pg_temp.check_that('a later adoption supersedes the station''s point of the same kind and name, and keeps the old one',
    (select count(*) = 1 from meganet.station_level_point where station_id = '_check_lvl_stn' and kind = 'ctr' and superseded_at is null and rl = 27.09)
    and (select count(*) = 1 from meganet.station_level_point where station_id = '_check_lvl_stn' and kind = 'ctr' and superseded_at is not null
                                                              and superseded_by = 'lvl-admin@example.test'));
end
$$;

-- ── 7. Returned for completion ───────────────────────────────────────────────

do $$
declare
  v text;
begin
  v := pg_temp.as_who('admin', 'select meganet.level_survey_return(''5b1e7c2a-0000-4000-8000-000000000004'', '''')');
  perform pg_temp.check_that('a survey is returned with a reason or not at all', v = '22023', v);
  v := pg_temp.as_who('editor', 'select meganet.level_survey_return(''5b1e7c2a-0000-4000-8000-000000000004'', ''close the run'')');
  perform pg_temp.check_that('only an administrator returns one', v = '42501/administrator', v);
  perform pg_temp.keep_as('admin', 'select meganet.level_survey_return(''5b1e7c2a-0000-4000-8000-000000000004'', ''close the run'')::text');
  perform pg_temp.check_that('returned, with why',
    (select status = 'returned' and decision_note = 'close the run' from meganet.level_survey where id = '5b1e7c2a-0000-4000-8000-000000000004'));
  v := pg_temp.as_who('admin', pg_temp.apply_sql('5b1e7c2a-0000-4000-8000-000000000004',
    '[{"key":"o","kind":"offset","value":{"correction_m":0.001}}]'));
  perform pg_temp.check_that('a returned survey is not applied until it is sent again', v = '55000', v);
  perform pg_temp.keep_as('editor', pg_temp.save_survey_sql(pg_temp.survey_doc('5b1e7c2a-0000-4000-8000-000000000004')));
  perform pg_temp.check_that('sent again, it is back in the queue',
    (select status = 'submitted' and outcome = 'pass' from meganet.level_survey where id = '5b1e7c2a-0000-4000-8000-000000000004'));
  v := pg_temp.as_who('admin', 'select meganet.level_survey_return(''5b1e7c2a-0000-4000-8000-000000000001'', ''late'')');
  perform pg_temp.check_that('an applied survey is not returned', v = '55000', v);
end
$$;

-- ── 8. Gauge zero is an administrator's in the station editor too ────────────

do $$
declare
  v     text;
  d     jsonb := (select doc from meganet.station_json where id = '_check_lvl_stn');
  stamp timestamptz := (select updated_at from meganet.station where id = '_check_lvl_stn');
  gs    jsonb := d -> 'gauge_survey';
  moved jsonb;
  noted jsonb;
  flipped jsonb;
begin
  -- The latest row's gauge zero moved by a centimetre.
  moved := (select jsonb_agg(case when e ->> 'valid_from' = '2026-07-12' then e || '{"gauge_zero_m": 26.81}' else e end)
              from jsonb_array_elements(gs) e);
  -- Only a note and an AMTD changed.
  noted := (select jsonb_agg(e || '{"note": "AMTD re-measured", "amtd_km": 12.4}') from jsonb_array_elements(gs) e);
  -- The same rows, the other way round, 26.80 written with its trailing zero.
  flipped := (select jsonb_agg(case when e ->> 'valid_from' = '2026-07-12' then e || '{"gauge_zero_m": "26.80"}' else e end order by o desc)
                from jsonb_array_elements(gs) with ordinality x(e, o));

  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)', jsonb_set(d, '{gauge_survey}', moved), stamp));
  perform pg_temp.check_that('an editor may not change a station''s gauge zero in the station editor', v = '42501/administrator', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)',
    jsonb_set(d, '{gauge_survey}', (select jsonb_agg(e || '{"datum": "ASSUM"}') from jsonb_array_elements(gs) e)), stamp));
  perform pg_temp.check_that('…nor its datum', v = '42501/administrator', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)',
    jsonb_set(d, '{gauge_survey}', '[]'::jsonb), stamp));
  perform pg_temp.check_that('…nor clear the list', v = '42501/administrator', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)', jsonb_set(d, '{gauge_survey}', noted), stamp));
  perform pg_temp.check_that('…but may still correct the AMTD and the notes', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)', jsonb_set(d, '{gauge_survey}', flipped), stamp));
  perform pg_temp.check_that('…and the same rows in another order, 26.80 for 26.8, are no change', v = 'ok', v);
  v := pg_temp.as_who('editor', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)', d - 'gauge_survey' || '{"notes": "edited"}', stamp));
  perform pg_temp.check_that('an editor''s save that leaves the list alone goes through as before', v = 'ok', v);
  v := pg_temp.as_who('admin', pg_catalog.format('select meganet.save_station(%L::jsonb, %L::timestamptz)', jsonb_set(d, '{gauge_survey}', moved), stamp));
  perform pg_temp.check_that('an administrator may change it', v = 'ok', v);
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
