-- check_station_lpu.sql — Prove a station's logger details and the photo
-- reader's door (0090), against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_lpu.sql
--
-- Every check below is one claim the head of 0090_station_lpu.sql makes, or
-- one rule its functions enforce. The whole script runs inside a transaction
-- and rolls back, so it is safe against the live database: nothing it writes
-- survives — the placeholder stations, the photos, the people it signs in as,
-- the logger details, the readings and the type it adds.
--
-- It needs to be run as a role the functions treat as a direct connection — a
-- psql session as the owner. It prints a row per check and exits non-zero if
-- any failed. CI runs it in the db-checks job after every migration has been
-- applied from zero (.github/workflows/web-smoke.yml).
--
-- What it deliberately does not check: which near misses the station editor
-- shows before a type may be added — that is lpu-types.js's, and
-- test/lputypes.mjs proves it — nor what the photo reader sees in a photo.

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

-- The SQLSTATE and the DETAIL line together, 'ok' when nothing was raised.
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
  return v_state || '/' || coalesce(v_det, '');
end;
$$;

-- One statement as another role with a request's claims, answered with its
-- first column as text or 'ERROR <sqlstate>', then rolled back.
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- …and the same, keeping what it wrote, for a save a later check reads.
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
  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return coalesce(v, '<null>');
end;
$$;

-- A well-formed photo, fresh uuid and hash each time (check_field_photos.sql's).
create or replace function pg_temp.photo(p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
           'storage_path', 'photo/' || u || '.jpg',
           'thumb_path',   'photo/' || u || '.thumb.jpg',
           'content_type', 'image/jpeg',
           'byte_size',    2163393,
           'sha256',       encode(sha256(convert_to(u, 'UTF8')), 'hex'),
           'title',        'IMG_0042.jpg') || p_extra
    from (select gen_random_uuid()::text as u) g;
$$;

-- A reading as the reader sends it, over any of its fields.
create or replace function pg_temp.reading(p_photo uuid, p_extra jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('photo_id', p_photo, 'reader', 'agent:photo-reader', 'reader_version', 1,
                            'model', 'check', 'outcome', 'found', 'summary', 'check_station_lpu') || p_extra;
$$;

-- The stamp to save with.
create or replace function pg_temp.stamp(p_station text)
returns text language sql as $$
  select coalesce(quote_literal(updated_at::text) || '::timestamptz', 'null')
    from (select (select updated_at from meganet.station_lpu where station_id = p_station) as updated_at) s;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Three stations in the Tasman Sea, one soft-deleted; an editor, a member who
-- is not one (an approved council crew), and a stranger; four photos filed
-- under the first station, taken in order, and one filed under none.

insert into meganet.rm_system (id, ord, name)
values (-989, -989, 'check_station_lpu placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon) values
  ('_check_lpu_a',    -989, 'Check LPU A',    '998390', -989, -31.5, 161.0),
  ('_check_lpu_b',    -990, 'Check LPU B',    '998391', -989, -31.6, 161.1),
  ('_check_lpu_gone', -991, 'Check LPU Gone', '998392', -989, -31.7, 161.2)
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_lpu_gone';

insert into meganet.editor_allow (entry, note) values
  ('lpu-editor@example.test', 'check_station_lpu — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c1a01', 'lpu-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000c1a02', 'lpu-crew@council.example.test', now())
on conflict (id) do nothing;
update meganet.app_user set status = 'approved' where id = '00000000-0000-4000-8000-0000000c1a02';

create temporary table _ids (k text primary key, id uuid) on commit drop;
insert into _ids select 'p1', (meganet.add_field_photo(pg_temp.photo(jsonb_build_object('station_id', '_check_lpu_a'))) ->> 'id')::uuid;
insert into _ids select 'p2', (meganet.add_field_photo(pg_temp.photo(jsonb_build_object('station_id', '_check_lpu_a'))) ->> 'id')::uuid;
insert into _ids select 'p3', (meganet.add_field_photo(pg_temp.photo(jsonb_build_object('station_id', '_check_lpu_a'))) ->> 'id')::uuid;
insert into _ids select 'p0', (meganet.add_field_photo(pg_temp.photo(jsonb_build_object('station_id', '_check_lpu_a'))) ->> 'id')::uuid;
insert into _ids select 'loose', (meganet.add_field_photo(pg_temp.photo()) ->> 'id')::uuid;
update meganet.field_photo set taken_at = '2025-03-01T10:00:00Z' where id = (select id from _ids where k = 'p1');
update meganet.field_photo set taken_at = '2026-05-01T10:00:00Z' where id = (select id from _ids where k = 'p2');
update meganet.field_photo set taken_at = '2026-09-01T10:00:00Z' where id = (select id from _ids where k = 'p3');
update meganet.field_photo set taken_at = '2024-01-01T10:00:00Z' where id = (select id from _ids where k = 'p0');

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',     '{"role":"anon"}'),
  ('stranger', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c1a09"}'),
  ('editor',   '{"role":"authenticated","email":"lpu-editor@example.test","sub":"00000000-0000-4000-8000-0000000c1a01"}'),
  ('crew',     '{"role":"authenticated","email":"lpu-crew@council.example.test","sub":"00000000-0000-4000-8000-0000000c1a02"}'),
  ('service',  '{"role":"service_role"}');

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
declare
  t text;
begin
  perform pg_temp.check_that('schema_version is at least 90',
    (select value::integer >= 90 from meganet.app_meta where key = 'schema_version'));

  foreach t in array array['lpu_type', 'station_lpu', 'station_lpu_change', 'photo_reading'] loop
    perform pg_temp.check_that(format('meganet.%s exists with RLS on', t),
      (select relrowsecurity from pg_catalog.pg_class where oid = to_regclass('meganet.' || t)),
      'db/README.md: no table without RLS, in the same file');
  end loop;

  perform pg_temp.check_that('the four that write or list are security definer with an empty search_path',
    (select count(*) = 4 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
       from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname in ('save_station_lpu', 'record_photo_reading', 'record_photo_readings', 'photos_to_read')),
    'db/README.md');

  perform pg_temp.check_that('ELPRO''s ERT-A2 and ten Campbell loggers are on the list, in their families',
    (select count(*) = 1 from meganet.lpu_type where key = 'elpro_ert_a2' and family = 'ert_a2')
    and (select count(*) = 10 from meganet.lpu_type where make = 'Campbell Scientific' and family = 'campbell'));

  perform pg_temp.check_that('CR300, CR310 and CR350 are three types, a digit apart',
    (select count(*) = 3 from meganet.lpu_type where key in ('campbell_cr300', 'campbell_cr310', 'campbell_cr350')));
end
$$;

-- ── 2. One type, however it is written ───────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('CR 300, cr-300, Campbell Scientific CR300 and Campbell''s CR300 are all CR300',
    meganet.lpu_match_key('CR 300') = 'CR300' and meganet.lpu_match_key('cr-300') = 'CR300'
    and meganet.lpu_match_key('Campbell Scientific CR300') = 'CR300'
    and meganet.lpu_match_key('Campbell''s CR300') = 'CR300'
    and meganet.lpu_match_key('CampbellScientific CR300') = 'CR300'
    and meganet.lpu_match_key('CSI cr300') = 'CR300',
    meganet.lpu_match_key('Campbell''s CR300'));

  perform pg_temp.check_that('ELPRO ERT-A2, ERRTS ERT A2 and ert a2 are all ERTA2',
    meganet.lpu_match_key('ELPRO ERT-A2') = 'ERTA2' and meganet.lpu_match_key('ERRTS ERT A2') = 'ERTA2'
    and meganet.lpu_match_key('ert a2') = 'ERTA2' and meganet.lpu_match_key('Elpro Technologies ERT-A2') = 'ERTA2');

  perform pg_temp.check_that('a make inside a word is not a make: ELPROX and CSIRO keep their letters',
    meganet.lpu_match_key('ELPROX 1') = 'ELPROX1' and meganet.lpu_match_key('CSIRO 2') = 'CSIRO2');

  perform pg_temp.check_that('CR1000 and CR1000X are two keys, and so two types',
    meganet.lpu_match_key('CR1000') <> meganet.lpu_match_key('CR1000X'));

  perform pg_temp.check_that('the list cannot hold one model twice, however it is spelt',
    pg_temp.refusal_of($q$insert into meganet.lpu_type (key, label, model) values ('check_dup', 'cr 300', 'cr 300')$q$) like '23505/%');
end
$$;

-- ── 3. Who may read, and who may write ──────────────────────────────────────

do $$
declare
  v text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('no authenticator role — the grant checks are skipped', true);
    return;
  end if;

  perform pg_temp.check_that('nobody holding a browser''s key can write any of the four tables',
    not has_table_privilege('authenticated', 'meganet.lpu_type', 'insert')
    and not has_table_privilege('authenticated', 'meganet.station_lpu', 'insert')
    and not has_table_privilege('authenticated', 'meganet.station_lpu', 'update')
    and not has_table_privilege('authenticated', 'meganet.station_lpu_change', 'insert')
    and not has_table_privilege('authenticated', 'meganet.photo_reading', 'insert')
    and not has_table_privilege('anon', 'meganet.lpu_type', 'insert'),
    'db/README.md: the ways in are functions');

  perform pg_temp.check_that('anon reads the list of types and nothing else here',
    has_table_privilege('anon', 'meganet.lpu_type', 'select')
    and not has_table_privilege('anon', 'meganet.station_lpu', 'select')
    and not has_table_privilege('anon', 'meganet.station_lpu_change', 'select')
    and not has_table_privilege('anon', 'meganet.photo_reading', 'select'));

  perform pg_temp.check_that('a browser may save; only the service key records a reading or lists the photos',
    has_function_privilege('authenticated', 'meganet.save_station_lpu(jsonb, timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'meganet.record_photo_reading(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'meganet.photos_to_read(text, integer, integer)', 'execute')
    and has_function_privilege('service_role', 'meganet.record_photo_reading(jsonb)', 'execute')
    and has_function_privilege('service_role', 'meganet.photos_to_read(text, integer, integer)', 'execute')
    and not has_function_privilege('anon', 'meganet.save_station_lpu(jsonb, timestamptz)', 'execute'));

  perform pg_temp.check_that('public holds EXECUTE on none of the three',
    not has_function_privilege('public', 'meganet.save_station_lpu(jsonb, timestamptz)', 'execute')
    and not has_function_privilege('public', 'meganet.record_photo_reading(jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.photos_to_read(text, integer, integer)', 'execute'));

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select count(*)::text from meganet.lpu_type where family = ''campbell''');
  perform pg_temp.check_that('anonymous reads the types', v::integer >= 10, v);
end
$$;

-- ── 4. A person records the logger ───────────────────────────────────────────

do $$
declare
  v   text;
  ed  text := (select claims from _who where k = 'editor');
begin
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'crew'),
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","lpu_type_key":"elpro_ert_a2"}')::text$q$);
  perform pg_temp.check_that('a member who is not an editor may not record a logger', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","lpu_type_key":"no_such_type"}')::text$q$);
  perform pg_temp.check_that('a type that is not on the list is refused', v = 'ERROR 23503', v);

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","firmware":"v1.7"}')::text$q$);
  perform pg_temp.check_that('a key the function does not take is refused, not ignored', v = 'ERROR 22023', v);

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_gone","lpu_type_key":"elpro_ert_a2"}')::text$q$);
  perform pg_temp.check_that('a deleted station has no logger to record', v = 'ERROR 23503', v);

  v := pg_temp.as_role_keep('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","lpu_type_key":"elpro_ert_a2","serial_no":"  A2-1234 ","firmware_version":"v1.7  Sep 20 2024 : 10366"}') ->> 'changed'$q$);
  perform pg_temp.check_that('an editor records the type, a serial and the firmware', v = 'true', v);

  perform pg_temp.check_that('…trimmed, with runs of spaces as one',
    (select serial_no = 'A2-1234' and firmware_version = 'v1.7 Sep 20 2024 : 10366' from meganet.station_lpu where station_id = '_check_lpu_a'));

  perform pg_temp.check_that('…each value saying a person entered it, and who',
    (select provenance -> 'firmware_version' ->> 'from' = 'person'
        and provenance -> 'firmware_version' ->> 'by' = 'lpu-editor@example.test'
        and provenance ? 'lpu_type_key' and not provenance ? 'program'
       from meganet.station_lpu where station_id = '_check_lpu_a'));

  perform pg_temp.check_that('…and the change is in its history, from nothing to what it became',
    (select count(*) = 1 from meganet.station_lpu_change
      where station_id = '_check_lpu_a' and source = 'person' and changed_by = 'lpu-editor@example.test'
        and before ->> 'serial_no' = '' and after ->> 'serial_no' = 'A2-1234'
        and before -> 'lpu_type_key' = 'null'::jsonb and after ->> 'lpu_type_key' = 'elpro_ert_a2'));

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","program":"x"}')::text$q$);
  perform pg_temp.check_that('a save with no stamp, once there is a row, is refused as stale', v = 'ERROR PT409', v);

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","program":"x"}', '2001-01-01')::text$q$);
  perform pg_temp.check_that('a save with an old stamp is refused as stale', v = 'ERROR PT409', v);

  v := pg_temp.as_role('authenticated', ed,
    format($q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","serial_no":"A2-1234"}', %s) ->> 'changed'$q$,
           pg_temp.stamp('_check_lpu_a')));
  perform pg_temp.check_that('a save that changes nothing says so', v = 'false', v);

  v := pg_temp.as_role_keep('authenticated', ed,
    format($q$select (meganet.save_station_lpu('{"station_id":"_check_lpu_a","serial_no":""}', %s) -> 'station_lpu') ->> 'serial_no'$q$,
           pg_temp.stamp('_check_lpu_a')));
  perform pg_temp.check_that('a value sent empty is cleared, and its provenance with it', v = ''
    and (select not provenance ? 'serial_no' from meganet.station_lpu where station_id = '_check_lpu_a'), v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'crew'),
    $q$select lpu_type_key from meganet.station_lpu where station_id = '_check_lpu_a'$q$);
  perform pg_temp.check_that('a member reads the station''s logger', v = 'elpro_ert_a2', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'crew'),
    $q$select count(*)::text from meganet.station_lpu_change$q$);
  perform pg_temp.check_that('…but not its history, which is editors''', v = '0', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'),
    $q$select count(*)::text from meganet.station_lpu$q$);
  perform pg_temp.check_that('a stranger reads none of it', v = '0', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select count(*)::text from meganet.station_lpu');
  perform pg_temp.check_that('anonymous cannot read it at all', v = 'ERROR 42501', v);
end
$$;

-- ── 5. A new type, only when it is meant ─────────────────────────────────────

do $$
declare
  v   text;
  ed  text := (select claims from _who where k = 'editor');
begin
  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","new_lpu_type":{"label":"OTT netDL 1000","make":"OTT HydroMet","model":"netDL 1000","family":"other"}}')::text$q$);
  perform pg_temp.check_that('a new type the editor has not said is new is refused', v = 'ERROR 22023', v);

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","new_lpu_type":{"label":"cr-300","model":"cr-300","confirm_new":true}}')::text$q$);
  perform pg_temp.check_that('a "new" type that is one on the list, spelt differently, is refused', v = 'ERROR 23505', v);

  v := pg_temp.refusal_of($q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","new_lpu_type":{"label":"Campbell CR 1000 X","model":"CR 1000 X","confirm_new":true}}')$q$);
  perform pg_temp.check_that('…and the refusal names the one it is', v = '23505/campbell_cr1000x', v);

  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","new_lpu_type":{"label":"OTT netDL 1000","make":"OTT HydroMet","model":"netDL 1000","family":"warp"}}')::text$q$);
  perform pg_temp.check_that('a family that is not one of the three is refused', v = 'ERROR 22023', v);

  v := pg_temp.as_role_keep('authenticated', ed,
    $q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","new_lpu_type":{"label":"OTT netDL 1000","make":"OTT HydroMet","model":"netDL 1000","family":"other","confirm_new":true},"firmware_version":"2.10"}') ->> 'added_type'$q$);
  perform pg_temp.check_that('a type confirmed as new is added with the station that first has it', v = 'ott_hydromet_netdl_1000', v);

  perform pg_temp.check_that('…on the list with its make, model, family and who added it',
    (select make = 'OTT HydroMet' and model = 'netDL 1000' and family = 'other' and note like 'Added by lpu-editor@example.test with _check_lpu_b%'
       from meganet.lpu_type where key = 'ott_hydromet_netdl_1000'));

  perform pg_temp.check_that('…and the station has it',
    (select lpu_type_key = 'ott_hydromet_netdl_1000' and firmware_version = '2.10' from meganet.station_lpu where station_id = '_check_lpu_b'));

  v := pg_temp.as_role('authenticated', ed,
    format($q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","new_lpu_type":{"label":"netdl1000","model":"NETDL-1000","confirm_new":true}}', %s)::text$q$,
           pg_temp.stamp('_check_lpu_b')));
  perform pg_temp.check_that('…and from then on it is a duplicate like any other', v = 'ERROR 23505', v);

  v := pg_temp.as_role('authenticated', ed,
    format($q$select meganet.save_station_lpu('{"station_id":"_check_lpu_b","lpu_type_key":"elpro_ert_a2","new_lpu_type":{"model":"X1","confirm_new":true}}', %s)::text$q$,
           pg_temp.stamp('_check_lpu_b')));
  perform pg_temp.check_that('a type key and a new type together is refused', v = 'ERROR 22023', v);
end
$$;

-- ── 6. The photo reader ──────────────────────────────────────────────────────

do $$
declare
  v    text;
  r    jsonb;
  p1   uuid := (select id from _ids where k = 'p1');
  p2   uuid := (select id from _ids where k = 'p2');
  p3   uuid := (select id from _ids where k = 'p3');
  p0   uuid := (select id from _ids where k = 'p0');
  ed   text := (select claims from _who where k = 'editor');
begin
  v := pg_temp.as_role('authenticated', ed,
    format($q$select meganet.record_photo_reading(%L)::text$q$, pg_temp.reading(p1, '{"outcome":"nothing"}')));
  perform pg_temp.check_that('an editor''s browser cannot record a reading', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', ed, $q$select count(*)::text from meganet.photos_to_read('agent:photo-reader')$q$);
  perform pg_temp.check_that('…nor list the photos to read', v = 'ERROR 42501', v);

  perform pg_temp.check_that('the photos to read include all five of these, before any is read',
    (select count(*) = 5 from meganet.photos_to_read('agent:photo-reader', 1, 1000) t
      where t.id in (select id from _ids)));

  -- A photo taken in 2025 shows the version screen: firmware, bootloader and
  -- the radio's, and the serial, which a person had already cleared.
  r := meganet.record_photo_reading(pg_temp.reading(p1, jsonb_build_object('lpu', jsonb_build_object(
         'lpu_type_key', 'elpro_ert_a2', 'serial_no', 'A2-1234', 'firmware_version', 'v1.6 Aug 25 2022 : 9814',
         'bootloader_version', 'v1.1 - 8708', 'radio_firmware_version', 'FW1.4, 9869',
         'confidence', 0.9, 'evidence', 'laptop screen, the version page'))));
  perform pg_temp.check_that('a reading fills what nobody has recorded',
    (select array_agg(x order by x) from jsonb_array_elements_text(r -> 'applied' -> 'lpu' -> 'filled') x)
      = array['bootloader_version', 'radio_firmware_version', 'serial_no'], r::text);
  perform pg_temp.check_that('…agrees with the type a person recorded, and writes nothing over it',
    (r -> 'applied' -> 'lpu' -> 'agreed') @> '["lpu_type_key"]'::jsonb
    and (select provenance -> 'lpu_type_key' ->> 'from' = 'person' from meganet.station_lpu where station_id = '_check_lpu_a'), r::text);
  perform pg_temp.check_that('…and the firmware a person entered stands, the photo''s disagreeing noted beside it',
    (select firmware_version = 'v1.7 Sep 20 2024 : 10366' from meganet.station_lpu where station_id = '_check_lpu_a')
    and (r -> 'applied' -> 'lpu' -> 'differed') @> jsonb_build_array(jsonb_build_object(
          'field', 'firmware_version', 'recorded', 'v1.7 Sep 20 2024 : 10366', 'read', 'v1.6 Aug 25 2022 : 9814')), r::text);
  perform pg_temp.check_that('a filled value says it came off that photo, by the reader, and how sure',
    (select provenance -> 'bootloader_version' ->> 'from' = 'photo'
        and provenance -> 'bootloader_version' ->> 'photo_id' = p1::text
        and provenance -> 'bootloader_version' ->> 'by' = 'agent:photo-reader'
        and (provenance -> 'bootloader_version' ->> 'confidence')::numeric = 0.9
        and not provenance -> 'bootloader_version' ? 'checked_at'
       from meganet.station_lpu where station_id = '_check_lpu_a'));
  perform pg_temp.check_that('…and its history says a photo did it, and which',
    (select count(*) = 1 from meganet.station_lpu_change
      where station_id = '_check_lpu_a' and source = 'photo' and photo_id = p1 and changed_by = 'agent:photo-reader'
        and after ->> 'bootloader_version' = 'v1.1 - 8708'));

  -- A later photo: the bootloader and radio upgraded. The bootloader nobody
  -- has checked gives way; the radio, once a person has checked it, does not.
  v := pg_temp.as_role_keep('authenticated', ed,
    format($q$select meganet.save_station_lpu('{"station_id":"_check_lpu_a","checked":["radio_firmware_version","firmware_version"]}', %s) ->> 'checked'$q$,
           pg_temp.stamp('_check_lpu_a')));
  perform pg_temp.check_that('a person checks a photo''s value — and checking a person''s own value is no check', v = '1', v);
  perform pg_temp.check_that('…which records who checked it, and when',
    (select provenance -> 'radio_firmware_version' ->> 'checked_by' = 'lpu-editor@example.test'
       from meganet.station_lpu where station_id = '_check_lpu_a'));

  r := meganet.record_photo_reading(pg_temp.reading(p3, jsonb_build_object('lpu', jsonb_build_object(
         'bootloader_version', 'v1.3 - 9967', 'radio_firmware_version', 'v1.4 (10301) FI:6015', 'confidence', 0.85))));
  perform pg_temp.check_that('a later photo replaces a value only a photo vouched for',
    (r -> 'applied' -> 'lpu' -> 'replaced') = '["bootloader_version"]'::jsonb
    and (select bootloader_version = 'v1.3 - 9967' and provenance -> 'bootloader_version' ->> 'photo_id' = p3::text
           from meganet.station_lpu where station_id = '_check_lpu_a'), r::text);
  perform pg_temp.check_that('…but not one a person has checked',
    (select radio_firmware_version = 'FW1.4, 9869' from meganet.station_lpu where station_id = '_check_lpu_a')
    and (r -> 'applied' -> 'lpu' -> 'differed') @> '[{"field":"radio_firmware_version"}]'::jsonb, r::text);

  r := meganet.record_photo_reading(pg_temp.reading(p0, jsonb_build_object('lpu', jsonb_build_object(
         'bootloader_version', 'v1.0 - 7000', 'confidence', 0.95))));
  perform pg_temp.check_that('an earlier photo does not replace a later one''s',
    (select bootloader_version = 'v1.3 - 9967' from meganet.station_lpu where station_id = '_check_lpu_a')
    and (r -> 'applied' -> 'lpu' -> 'differed') @> '[{"field":"bootloader_version"}]'::jsonb, r::text);

  r := meganet.record_photo_reading(pg_temp.reading(p2, jsonb_build_object('lpu', jsonb_build_object(
         'program', 'BOM_ALERT_v2', 'os_version', 'Std.10', 'confidence', 0.3))));
  perform pg_temp.check_that('a reading less than half sure is kept, not applied',
    (r -> 'applied' -> 'lpu' ->> 'skipped') like 'only 0.3 sure%'
    and (select program = '' from meganet.station_lpu where station_id = '_check_lpu_a'), r::text);

  r := meganet.record_photo_reading(pg_temp.reading(p2, jsonb_build_object('reader_version', 2, 'lpu', jsonb_build_object(
         'lpu_type_key', 'campbell_cr9000', 'serial_no', 'A2 1234', 'confidence', 0.8))));
  perform pg_temp.check_that('a type not on the list is never added by the reader',
    (r -> 'applied' -> 'lpu' -> 'skipped') @> '[{"field":"lpu_type_key","value":"campbell_cr9000"}]'::jsonb
    and not exists (select 1 from meganet.lpu_type where key = 'campbell_cr9000'), r::text);
  perform pg_temp.check_that('a serial read with a space in it is the same serial',
    (r -> 'applied' -> 'lpu' -> 'agreed') = '["serial_no"]'::jsonb, r::text);

  -- Everything else in the photo goes to the register's queue.
  r := meganet.record_photo_reading(pg_temp.reading(p2, jsonb_build_object('equipment', jsonb_build_array(
         jsonb_build_object('equipment_key', 'solar_regulator', 'make', 'Victron Energy', 'model', 'SmartSolar MPPT 75/15',
                            'serial_no', 'HQ2101ABCDE', 'evidence', 'label on the regulator', 'confidence', 0.8),
         jsonb_build_object('equipment_key', 'key_number', 'serial_no', '1234', 'confidence', 0.9),
         jsonb_build_object('equipment_key', 'flux_capacitor', 'model', 'X', 'confidence', 0.9)))));
  perform pg_temp.check_that('a regulator''s serial is proposed for the register, as the reader',
    jsonb_array_length(r -> 'applied' -> 'equipment' -> 'proposed') = 1
    and (select proposed_by = 'agent:photo-reader' and status = 'pending' and photo_id = p2
           from meganet.equipment_suggestion where id = (r -> 'applied' -> 'equipment' -> 'proposed' ->> 0)::uuid), r::text);
  perform pg_temp.check_that('a key number is refused outright, and a kind the register does not know is refused',
    (r -> 'applied' -> 'equipment' -> 'refused') @> '[{"equipment_key":"key_number"},{"equipment_key":"flux_capacitor"}]'::jsonb
    and not exists (select 1 from meganet.equipment_suggestion where equipment_key = 'key_number' and photo_id = p2), r::text);

  r := meganet.record_photo_reading(pg_temp.reading(p2, jsonb_build_object('equipment', jsonb_build_array(
         jsonb_build_object('equipment_key', 'solar_regulator', 'make', 'Victron Energy',
                            'serial_no', 'HQ2101ABCDE', 'confidence', 0.8)))));
  perform pg_temp.check_that('read again, the same regulator is known, not proposed twice',
    (r -> 'applied' -> 'equipment' ->> 'known') = '1'
    and (select count(*) = 1 from meganet.equipment_suggestion where photo_id = p2 and status = 'pending'), r::text);
  perform pg_temp.check_that('…and the reading of that photo is one row, the latest',
    (select count(*) = 1 from meganet.photo_reading where photo_id = p2 and reader_version = 1)
    and (select (applied -> 'equipment' ->> 'known') = '1' from meganet.photo_reading where photo_id = p2 and reader_version = 1));

  r := meganet.record_photo_reading(pg_temp.reading((select id from _ids where k = 'loose'), jsonb_build_object('lpu', jsonb_build_object(
         'firmware_version', 'v1.7', 'confidence', 0.9))));
  perform pg_temp.check_that('a photo filed under no station is read, and nothing applied',
    (r -> 'applied' -> 'lpu' ->> 'skipped') = 'the photo is not filed under a station', r::text);

  perform pg_temp.check_that('reader, version and outcome are checked',
    pg_temp.refusal_of(format($q$select meganet.record_photo_reading(%L)$q$, pg_temp.reading(p1, '{"reader":"photo-reader"}'))) like '22023/%'
    and pg_temp.refusal_of(format($q$select meganet.record_photo_reading(%L)$q$, pg_temp.reading(p1, '{"outcome":"maybe"}'))) like '22023/%'
    and pg_temp.refusal_of(format($q$select meganet.record_photo_reading(%L)$q$, pg_temp.reading(p1, '{"lpu":{"firmware_version":"v1"}}'))) like '22023/%');

  perform pg_temp.check_that('the photos to read are the ones not read at this version',
    (select count(*) = 0 from meganet.photos_to_read('agent:photo-reader', 1, 1000) t where t.id in (select id from _ids))
    and (select count(*) = 4 from meganet.photos_to_read('agent:photo-reader', 2, 1000) t where t.id in (select id from _ids)));

  r := meganet.record_photo_readings(jsonb_build_object('reader', 'agent:photo-reader', 'reader_version', 3, 'model', 'check',
         'readings', jsonb_build_array(
           jsonb_build_object('photo_id', p0, 'outcome', 'nothing', 'summary', 'gauge boards'),
           jsonb_build_object('photo_id', p3, 'outcome', 'found', 'lpu', jsonb_build_object('program', 'BOM_ALERT_v2', 'confidence', 0.8)),
           jsonb_build_object('photo_id', p1, 'outcome', 'maybe'),
           jsonb_build_object('photo_id', gen_random_uuid(), 'outcome', 'nothing'))));
  perform pg_temp.check_that('a batch: each recorded on its own, the refused ones said with why, the rest kept',
    (r ->> 'recorded') = '2' and jsonb_array_length(r -> 'failed') = 2
    and (r -> 'failed' -> 0 ->> 'why') like 'outcome is nothing, found or unreadable%'
    and (r -> 'filled') @> '[{"station_id":"_check_lpu_a","fields":["program"]}]'::jsonb
    and (select count(*) = 2 from meganet.photo_reading where reader_version = 3), r::text);
  v := pg_temp.as_role('authenticated', ed,
    $q$select meganet.record_photo_readings('{"reader":"agent:photo-reader","reader_version":1,"readings":[]}')::text$q$);
  perform pg_temp.check_that('…and a browser cannot send one', v = 'ERROR 42501', v);


  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'crew'),
    $q$select count(*)::text from meganet.photo_reading$q$);
  perform pg_temp.check_that('a member does not read the readings — editors do', v = '0', v);
  v := pg_temp.as_role('authenticated', ed,
    format($q$select count(*)::text from meganet.photo_reading where photo_id = %L$q$, p2));
  perform pg_temp.check_that('…an editor does', v = '2', v);
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
