-- check_photo_review.sql — Prove the upload log, the administrator, the
-- equipment register and its suggestions (0036), against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_photo_review.sql
--
-- Every check below is one claim the head of 0036_photo_review.sql makes, or
-- one rule its functions enforce. The whole script runs inside a transaction
-- and rolls back, so it is safe against the live database: nothing it writes
-- survives — the placeholder stations, the photos, the three people it signs
-- in as (one of them made an administrator, one unmade), the log rows, the
-- register and the suggestions.
--
-- It needs to be run as a role meganet.is_editor() and meganet.is_admin() say
-- yes to — a direct psql connection, or one holding the service key. It prints
-- a row per check and exits non-zero if any of them failed. CI runs it in the
-- db-checks job after every migration has been applied from zero, beside
-- tools/check_field_photos.sql (.github/workflows/web-smoke.yml).
--
-- What it deliberately does not check: the browser's half — which rows the tab
-- logs when an upload finishes, which corrections it sends with an approval,
-- and what it reads off a label — which is test/photoreview.mjs's.

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

-- The SQLSTATE a statement raised, or 'ok'.
create or replace function pg_temp.state_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The SQLSTATE and the DETAIL line together, 'ok' when nothing was raised: a
-- collision is only half proven until it names what it collided with.
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

-- Run one query as another role with the claims a request would carry, and
-- say what it returned — then roll it back (check_field_photos.sql's helper,
-- and its reason). Whatever the query wrote goes with it.
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

-- Log some rows and read back who and when they were stamped with. Two
-- statements, because rows a function inserts are not in the snapshot of the
-- statement that called it; definer, so the read-back sees them whichever
-- role asked (the scaffold's service_role, unlike Supabase's, does not bypass
-- RLS). The log call itself still sees the caller's role and claims — those
-- are GUCs, which entering a definer function does not touch (0004).
create or replace function pg_temp.logged(p_rows jsonb)
returns text language plpgsql security definer as $$
declare
  v_batch uuid;
begin
  v_batch := (meganet.log_field_photo_upload(p_rows) ->> 'batch_id')::uuid;
  return (select string_agg(uploaded_by || ' ' || to_char(attempted_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), ', ')
            from meganet.field_photo_upload where batch_id = v_batch);
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

-- A suggestion, as the tab's OCR would send it, over any of its fields.
create or replace function pg_temp.proposal(p_extra jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('equipment_key', 'logger', 'make', 'Campbell Scientific', 'model', 'CR300',
                            'serial_no', '12345', 'evidence', 'CAMPBELL SCIENTIFIC CR300 S/N: 12345',
                            'confidence', 0.9, 'proposed_by', 'ocr') || p_extra;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Two stations in the Tasman Sea and one soft-deleted; three people — an
-- editor, an administrator, and a former administrator whose address has since
-- been taken off the editors list — signed up the way the signup triggers
-- (0005) provision them; two photos filed under the first station, and one
-- filed under none.

insert into meganet.rm_system (id, ord, name)
values (-986, -986, 'check_photo_review placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon) values
  ('_check_pr_a',    -986, 'Check Review A',    '998360', -986, -31.5, 161.0),
  ('_check_pr_b',    -987, 'Check Review B',    '998361', -986, -31.6, 161.1),
  ('_check_pr_gone', -988, 'Check Review Gone', '998362', -986, -31.7, 161.2)
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_pr_gone';

insert into meganet.editor_allow (entry, note) values
  ('review-editor@example.test', 'check_photo_review — rolled back'),
  ('review-admin@example.test',  'check_photo_review — rolled back'),
  ('review-former@example.test', 'check_photo_review — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c0e01', 'review-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000c0e02', 'review-admin@example.test', now()),
  ('00000000-0000-4000-8000-0000000c0e03', 'review-former@example.test', now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin'
 where id in ('00000000-0000-4000-8000-0000000c0e02', '00000000-0000-4000-8000-0000000c0e03');
delete from meganet.editor_allow where entry = 'review-former@example.test';

create temporary table _ids (k text primary key, id uuid) on commit drop;

insert into _ids
select 'photo1', (meganet.add_field_photo(pg_temp.photo(jsonb_build_object('station_id', '_check_pr_a'))) ->> 'id')::uuid;
insert into _ids
select 'photo2', (meganet.add_field_photo(pg_temp.photo(jsonb_build_object('station_id', '_check_pr_a'))) ->> 'id')::uuid;
insert into _ids
select 'loose',  (meganet.add_field_photo(pg_temp.photo()) ->> 'id')::uuid;

-- The claims each person's request would carry.
create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',     '{"role":"anon"}'),
  ('stranger', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c0e09"}'),
  ('editor',   '{"role":"authenticated","email":"review-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0e01"}'),
  ('admin',    '{"role":"authenticated","email":"review-admin@example.test","sub":"00000000-0000-4000-8000-0000000c0e02"}'),
  ('former',   '{"role":"authenticated","email":"review-former@example.test","sub":"00000000-0000-4000-8000-0000000c0e03"}'),
  ('service',  '{"role":"service_role"}');

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
declare
  v_fns text[] := array['log_field_photo_upload', 'prune_field_photo_uploads', 'is_admin',
                        'propose_equipment', 'decide_equipment_suggestion',
                        'equipment_serial_key', 'equipment_identity'];
  t     text;
begin
  perform pg_temp.check_that('schema_version is at least 36',
    (select value::integer >= 36 from meganet.app_meta where key = 'schema_version'));

  foreach t in array array['field_photo_outcome', 'field_photo_upload', 'equipment_source',
                           'station_equipment', 'equipment_suggestion'] loop
    perform pg_temp.check_that(format('meganet.%s exists with RLS on', t),
      (select relrowsecurity from pg_catalog.pg_class where oid = to_regclass('meganet.' || t)),
      'db/README.md: no table without RLS, in the same file');
  end loop;

  perform pg_temp.check_that('all seven functions exist',
    (select count(distinct p.proname) = 7 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname = any(v_fns)));

  perform pg_temp.check_that('the four that write, and is_admin(), are security definer with an empty search_path',
    (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname = any(v_fns[1:5])),
    'db/README.md');

  perform pg_temp.check_that('Google Drive is a way in, beside the tab and Dropbox',
    (select count(*) = 3 from meganet.field_photo_origin where key in ('upload', 'dropbox', 'gdrive')));

  perform pg_temp.check_that('six outcomes, and only imported, unplaced and duplicate point at a photo',
    (select count(*) = 6 from meganet.field_photo_outcome)
    and (select array_agg(key order by key) = array['duplicate', 'imported', 'unplaced']
           from meganet.field_photo_outcome where has_photo));

  perform pg_temp.check_that('four ways an entry on the register is known',
    (select array_agg(key order by ord) = array['photo', 'inspection', 'manual', 'agent'] from meganet.equipment_source));
end
$$;

-- ── 2. The grants: read by editors, written only through the functions ───────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('no authenticator role — the grant checks are skipped', true);
    return;
  end if;

  perform pg_temp.check_that('authenticated may only SELECT the log, the register and the suggestions',
    has_table_privilege('authenticated', 'meganet.field_photo_upload', 'select')
    and has_table_privilege('authenticated', 'meganet.station_equipment', 'select')
    and has_table_privilege('authenticated', 'meganet.equipment_suggestion', 'select')
    and not has_table_privilege('authenticated', 'meganet.field_photo_upload', 'insert')
    and not has_table_privilege('authenticated', 'meganet.station_equipment', 'insert')
    and not has_table_privilege('authenticated', 'meganet.station_equipment', 'update')
    and not has_table_privilege('authenticated', 'meganet.equipment_suggestion', 'update')
    and not has_table_privilege('authenticated', 'meganet.equipment_suggestion', 'delete'),
    'db/README.md: nothing is writable by anon or authenticated; the ways in are functions');

  perform pg_temp.check_that('anon may read the two new vocabularies and none of the rest',
    has_table_privilege('anon', 'meganet.field_photo_outcome', 'select')
    and has_table_privilege('anon', 'meganet.equipment_source', 'select')
    and not has_table_privilege('anon', 'meganet.field_photo_upload', 'select')
    and not has_table_privilege('anon', 'meganet.station_equipment', 'select')
    and not has_table_privilege('anon', 'meganet.equipment_suggestion', 'select'),
    'a register of serial numbers is a shopping list');

  perform pg_temp.check_that('an editor may call the log, propose and decide (decide asks is_admin itself)',
    has_function_privilege('authenticated', 'meganet.log_field_photo_upload(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'meganet.propose_equipment(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'meganet.decide_equipment_suggestion(uuid, text, text, jsonb)', 'execute')
    and has_function_privilege('authenticated', 'meganet.is_admin()', 'execute'));

  perform pg_temp.check_that('pruning the log is the service key''s (and the owner''s) alone',
    has_function_privilege('service_role', 'meganet.prune_field_photo_uploads(interval)', 'execute')
    and not has_function_privilege('authenticated', 'meganet.prune_field_photo_uploads(interval)', 'execute')
    and not has_function_privilege('anon', 'meganet.prune_field_photo_uploads(interval)', 'execute'));

  perform pg_temp.check_that('public holds EXECUTE on none of the seven',
    not has_function_privilege('public', 'meganet.log_field_photo_upload(jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.prune_field_photo_uploads(interval)', 'execute')
    and not has_function_privilege('public', 'meganet.is_admin()', 'execute')
    and not has_function_privilege('public', 'meganet.propose_equipment(jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.decide_equipment_suggestion(uuid, text, text, jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.equipment_serial_key(text)', 'execute')
    and not has_function_privilege('public', 'meganet.equipment_identity(text, text)', 'execute'),
    'db/README.md: a function that writes has its EXECUTE revoked from public, in the same file');
end
$$;

-- ── 3. Who is an administrator ───────────────────────────────────────────────

do $$
declare
  v text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    perform pg_temp.check_that('no API roles — the sign-in checks are skipped', true);
    return;
  end if;

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.is_admin()::text');
  perform pg_temp.check_that('anonymous is not an administrator', v = 'false', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'), 'select meganet.is_admin()::text');
  perform pg_temp.check_that('a signed-in address that is not an editor is not one', v = 'false', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), 'select meganet.is_admin()::text');
  perform pg_temp.check_that('an editor is not one — being on the list is not being an administrator', v = 'false', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), 'select meganet.is_admin()::text');
  perform pg_temp.check_that('an editor whose app_user row says admin is one', v = 'true', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'former'), 'select meganet.is_admin()::text');
  perform pg_temp.check_that('an administrator taken off the editors list is not one any more',
    v = 'false', 'the row still says admin; the list is what lets anybody in: ' || v);

  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'), 'select meganet.is_admin()::text');
  perform pg_temp.check_that('the service key is one', v = 'true', v);

  perform pg_temp.check_that('…and so is the owner at a psql prompt', meganet.is_admin());
end
$$;

-- ── 4. The upload log ─────────────────────────────────────────────────────────

do $$
declare
  v_photo  uuid := (select id from _ids where k = 'photo1');
  v_out    jsonb;
  v_batch  uuid := gen_random_uuid();
  v_n      integer;
  refuse   text := 'select meganet.log_field_photo_upload(%L::jsonb)';
begin
  v_out := meganet.log_field_photo_upload(jsonb_build_array(
    jsonb_build_object('batch_id', v_batch, 'file_name', 'IMG_0042.jpg', 'outcome', 'imported',
                       'photo_id', v_photo, 'station_id', '_check_pr_a', 'byte_size', 2163393,
                       'sha256', repeat('a', 64)),
    jsonb_build_object('batch_id', v_batch, 'file_name', 'IMG_0043.jpg', 'archive_name', 'site-visit.zip',
                       'outcome', 'duplicate', 'photo_id', v_photo, 'reason', 'Already in MegaNet — added by x on 2026-06-24.'),
    jsonb_build_object('batch_id', v_batch, 'file_name', 'IMG_0044.HEIC', 'archive_name', 'site-visit.zip',
                       'outcome', 'refused', 'reason', 'the HEIC could not be decoded')));
  perform pg_temp.check_that('three outcomes logged in one call', (v_out ->> 'logged')::integer = 3, v_out::text);

  select count(*) into v_n from meganet.field_photo_upload where batch_id = v_batch;
  perform pg_temp.check_that('…one batch, from the upload door, stamped with the caller and the server''s clock',
    v_n = 3 and (select bool_and(origin = 'upload' and uploaded_by <> '' and attempted_at = now())
                   from meganet.field_photo_upload where batch_id = v_batch));
  perform pg_temp.check_that('…the zip each came out of kept, and the photo each became',
    (select archive_name = 'site-visit.zip' and photo_id = v_photo
       from meganet.field_photo_upload where batch_id = v_batch and file_name = 'IMG_0043.jpg')
    and (select photo_id is null from meganet.field_photo_upload where batch_id = v_batch and file_name = 'IMG_0044.HEIC'));

  v_out := meganet.log_field_photo_upload(jsonb_build_array(
    jsonb_build_object('file_name', 'DSC_0001.JPG', 'origin', 'gdrive', 'outcome', 'unplaced', 'photo_id', v_photo),
    jsonb_build_object('file_name', 'notes.txt', 'origin', 'gdrive', 'outcome', 'skipped', 'reason', 'not a photo')));
  perform pg_temp.check_that('rows with no batch share one the call makes, and Google Drive is a way in',
    (select count(*) = 2 from meganet.field_photo_upload where batch_id = (v_out ->> 'batch_id')::uuid and origin = 'gdrive'),
    v_out::text);

  perform pg_temp.check_that('an empty list logs nothing and is not an error',
    (meganet.log_field_photo_upload('[]'::jsonb) ->> 'logged')::integer = 0);

  perform pg_temp.check_that('refuses something that is not a list of rows',
    pg_temp.state_of(format(refuse, '{"file_name":"x.jpg","outcome":"imported"}')) = '22023');
  perform pg_temp.check_that('refuses more than 500 rows in one call',
    pg_temp.state_of(format(refuse, (select jsonb_agg(jsonb_build_object('file_name', 'f' || g || '.jpg', 'outcome', 'failed'))
                                       from generate_series(1, 501) g))) = '22023');
  perform pg_temp.check_that('refuses a key it does not know',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"imported","colour":"blue"}]')) = '22023');
  perform pg_temp.check_that('refuses a row with no file name',
    pg_temp.state_of(format(refuse, '[{"file_name":"  ","outcome":"imported"}]')) = '22023');
  perform pg_temp.check_that('refuses an outcome that is not in the vocabulary',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"vanished"}]')) = '23503');
  perform pg_temp.check_that('refuses a way in that is not in the vocabulary',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"failed","origin":"carrier-pigeon"}]')) = '23503');
  perform pg_temp.check_that('refuses a photo for a file that did not get in',
    pg_temp.state_of(format(refuse, jsonb_build_array(jsonb_build_object('file_name', 'x.jpg', 'outcome', 'refused', 'photo_id', v_photo)))) = '22023');
  perform pg_temp.check_that('refuses a photo that does not exist',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"imported","photo_id":"00000000-0000-4000-8000-000000000999"}]')) = '23503');
  perform pg_temp.check_that('refuses a station that does not exist',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"failed","station_id":"_no_such_station"}]')) = '23503');
  perform pg_temp.check_that('refuses a hash that is not a SHA-256',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"failed","sha256":"ABC"}]')) = '22023');
  perform pg_temp.check_that('refuses a clock the caller sends — the server keeps the time',
    pg_temp.state_of(format(refuse, '[{"file_name":"x.jpg","outcome":"failed","attempted_at":"2020-01-01T00:00:00Z"}]')) = '42501');
  perform pg_temp.check_that('one bad row refuses the batch, and nothing of it is written',
    pg_temp.state_of(format(refuse, '[{"file_name":"good.jpg","outcome":"failed"},{"file_name":"bad.jpg","outcome":"vanished"}]')) = '23503'
    and not exists (select 1 from meganet.field_photo_upload where file_name = 'good.jpg'));
end
$$;

do $$
declare
  v text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    return;
  end if;

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'),
    'select meganet.log_field_photo_upload(''[{"file_name":"x.jpg","outcome":"failed"}]'')::text');
  perform pg_temp.check_that('anonymous cannot write the log', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'),
    'select meganet.log_field_photo_upload(''[{"file_name":"x.jpg","outcome":"failed"}]'')::text');
  perform pg_temp.check_that('a signed-in address that is not an editor cannot either', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select pg_temp.logged(''[{"file_name":"x.jpg","outcome":"failed","reason":"HTTP 503"}]'')');
  perform pg_temp.check_that('an editor can, and is recorded as the one who did, now',
    v = 'review-editor@example.test ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select meganet.log_field_photo_upload(''[{"file_name":"x.jpg","outcome":"failed","uploaded_by":"somebody.else@example.test"}]'')::text');
  perform pg_temp.check_that('…and cannot say it was somebody else', v = 'ERROR 42501', v);

  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'),
    'select pg_temp.logged(''[{"file_name":"IMG_9.jpg","origin":"dropbox","outcome":"failed",
                               "attempted_at":"2026-06-24T02:30:00Z","uploaded_by":"Dropbox — Flood Crew"}]'')');
  perform pg_temp.check_that('the sync, as service_role, says when it handled a file and whose folder it came from',
    v = 'Dropbox — Flood Crew 2026-06-24 02:30', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select count(*)::text from meganet.field_photo_upload where file_name like ''IMG_004%''');
  perform pg_temp.check_that('an editor reads the log', v = '3', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'),
    'select count(*)::text from meganet.field_photo_upload');
  perform pg_temp.check_that('a signed-in address that is not an editor reads none of it', v = '0', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select count(*)::text from meganet.field_photo_upload');
  perform pg_temp.check_that('anonymous cannot read the table at all', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
    'select meganet.prune_field_photo_uploads()::text');
  perform pg_temp.check_that('not even an administrator prunes from a browser — the grant is the service key''s',
    v = 'ERROR 42501', v);
end
$$;

do $$
declare
  v_n integer;
begin
  insert into meganet.field_photo_upload (attempted_at, origin, batch_id, file_name, outcome)
  values (now() - interval '400 days', 'upload', gen_random_uuid(), 'ancient.jpg', 'imported');

  perform pg_temp.check_that('the log keeps at least a week, whatever it is asked',
    pg_temp.state_of('select meganet.prune_field_photo_uploads(interval ''1 day'')') = '22023');
  v_n := meganet.prune_field_photo_uploads();
  perform pg_temp.check_that('pruning takes rows older than half a year and leaves this morning''s',
    v_n >= 1 and not exists (select 1 from meganet.field_photo_upload where file_name = 'ancient.jpg')
    and exists (select 1 from meganet.field_photo_upload where file_name = 'IMG_0042.jpg'), v_n::text);
end
$$;

-- ── 5. Proposing ──────────────────────────────────────────────────────────────

do $$
declare
  v_photo1 uuid := (select id from _ids where k = 'photo1');
  v_photo2 uuid := (select id from _ids where k = 'photo2');
  v_loose  uuid := (select id from _ids where k = 'loose');
  v_out    jsonb;
  v_first  uuid;
  refuse   text := 'select meganet.propose_equipment(%L::jsonb)';
begin
  v_out := meganet.propose_equipment(pg_temp.proposal(jsonb_build_object('photo_id', v_photo1)));
  v_first := (v_out ->> 'id')::uuid;
  insert into _ids values ('s_logger', v_first);
  perform pg_temp.check_that('a logger read off a photo is proposed, for the station the photo is filed under',
    v_out ->> 'station_id' = '_check_pr_a' and v_out ->> 'status' = 'pending' and v_out ->> 'proposed_by' = 'ocr'
    and v_out ->> 'serial_no' = '12345' and (v_out ->> 'confidence')::numeric = 0.9, v_out::text);
  perform pg_temp.check_that('…and who pressed the button is kept beside what read it',
    coalesce(v_out ->> 'created_by', '') <> '' and v_out ->> 'created_by' <> 'ocr', v_out ->> 'created_by');

  perform pg_temp.check_that('the same unit from the same photo, waiting, is refused and named',
    pg_temp.refusal_of(format(refuse, pg_temp.proposal(jsonb_build_object('photo_id', v_photo1)))) = '23505/' || v_first);
  perform pg_temp.check_that('…however its serial is punctuated or spaced',
    pg_temp.refusal_of(format(refuse, pg_temp.proposal(jsonb_build_object('photo_id', v_photo1, 'serial_no', '123-45')))) = '23505/' || v_first
    and pg_temp.refusal_of(format(refuse, pg_temp.proposal(jsonb_build_object('photo_id', v_photo1, 'serial_no', ' 12 345 ')))) = '23505/' || v_first,
    'a label (S/N) is the reader''s to strip; punctuation and case are the database''s to ignore');

  v_out := meganet.propose_equipment(pg_temp.proposal(jsonb_build_object('photo_id', v_photo2)));
  insert into _ids values ('s_logger2', (v_out ->> 'id')::uuid);
  perform pg_temp.check_that('the same unit from another photo is a suggestion of its own',
    v_out ->> 'status' = 'pending' and (v_out ->> 'id')::uuid <> v_first);

  v_out := meganet.propose_equipment(jsonb_build_object('photo_id', v_photo1, 'equipment_key', 'solar_regulator',
    'make', 'Victron Energy', 'model', 'SmartSolar MPPT 100/30', 'proposed_by', 'ocr'));
  insert into _ids values ('s_mppt', (v_out ->> 'id')::uuid);
  perform pg_temp.check_that('a unit with no serial is proposed by its model',
    v_out ->> 'serial_no' = '' and v_out ->> 'model' = 'SmartSolar MPPT 100/30');
  v_out := meganet.propose_equipment(jsonb_build_object('photo_id', v_photo1, 'equipment_key', 'solar_regulator',
    'make', 'Victron Energy', 'model', 'BlueSolar MPPT 75/15', 'proposed_by', 'ocr'));
  perform pg_temp.check_that('…so one photo can show two of a kind that no serial tells apart',
    v_out ->> 'status' = 'pending');
  perform pg_temp.check_that('…but not the same model twice',
    pg_temp.state_of(format(refuse, jsonb_build_object('photo_id', v_photo1, 'equipment_key', 'solar_regulator',
      'model', 'smartsolar mppt 100/30', 'proposed_by', 'ocr'))) = '23505');

  perform pg_temp.check_that('refuses a photo filed under no station, when no station is sent',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('photo_id', v_loose)))) = '22023');
  v_out := meganet.propose_equipment(pg_temp.proposal(jsonb_build_object('photo_id', v_loose, 'station_id', '_check_pr_b')));
  perform pg_temp.check_that('…and takes it with one', v_out ->> 'station_id' = '_check_pr_b');
  perform pg_temp.check_that('refuses a station that has been soft-deleted',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_gone')))) = '23503');
  perform pg_temp.check_that('refuses a photo that does not exist',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('photo_id', '00000000-0000-4000-8000-000000000999')))) = '23503');
  perform pg_temp.check_that('refuses a kind of equipment the register does not know',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'equipment_key', 'flux_capacitor')))) = '23503');
  perform pg_temp.check_that('refuses a suggestion that says nothing',
    pg_temp.state_of(format(refuse, jsonb_build_object('station_id', '_check_pr_a', 'equipment_key', 'logger', 'make', ' ', 'proposed_by', 'ocr'))) = '22023');
  perform pg_temp.check_that('refuses a confidence outside 0 to 1',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '777', 'confidence', 1.5)))) = '22023');
  perform pg_temp.check_that('refuses a key it does not know',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'colour', 'grey')))) = '22023');
  perform pg_temp.check_that('refuses something that is not a proposer',
    pg_temp.state_of(format(refuse, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '778', 'proposed_by', 'a hunch')))) = '22023');

  -- An agent, proposing from nothing but its own reading of the history.
  v_out := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'modem',
    'make', 'Beam', 'model', 'Iridium SBD', 'serial_no', '300234010123450',
    'evidence', 'The 2025-11 inspection lists IMEI 300234010123450', 'confidence', 0.6, 'proposed_by', 'agent:history-reader'));
  insert into _ids values ('s_agent', (v_out ->> 'id')::uuid);
  perform pg_temp.check_that('an agent proposes with no photo, as agent:<name>, from the owner''s connection',
    v_out ->> 'photo_id' is null and v_out ->> 'proposed_by' = 'agent:history-reader');
  perform pg_temp.check_that('…and the same unit at the same station twice is refused for it too',
    pg_temp.refusal_of(format(refuse, jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'modem',
      'serial_no', '300234010123450', 'proposed_by', 'agent:history-reader'))) = '23505/' || (v_out ->> 'id'));
end
$$;

do $$
declare
  v text;
  q text := 'select meganet.propose_equipment(%L::jsonb) ->> %L';
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    return;
  end if;

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '901')), 'id'));
  perform pg_temp.check_that('anonymous cannot propose', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '902')), 'id'));
  perform pg_temp.check_that('a signed-in address that is not an editor cannot', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '903')), 'created_by'));
  perform pg_temp.check_that('an editor proposes what the OCR read, and is recorded as the one who asked',
    v = 'review-editor@example.test', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '904', 'proposed_by', null)), 'proposed_by'));
  perform pg_temp.check_that('…or as themselves', v = 'review-editor@example.test', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '905', 'proposed_by', 'agent:me')), 'id'));
  perform pg_temp.check_that('…but not as an agent', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '906', 'proposed_by', 'somebody.else@example.test')), 'id'));
  perform pg_temp.check_that('…nor as somebody else', v = 'ERROR 42501', v);

  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '907', 'proposed_by', 'agent:label-reader')), 'proposed_by'));
  perform pg_temp.check_that('the service key proposes as an agent — the seam an agent will use', v = 'agent:label-reader', v);

  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'),
    format(q, pg_temp.proposal(jsonb_build_object('station_id', '_check_pr_a', 'serial_no', '908', 'proposed_by', null)), 'id'));
  perform pg_temp.check_that('…and has to say which agent', v = 'ERROR 22023', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select count(*)::text from meganet.equipment_suggestion where station_id = ''_check_pr_a''');
  perform pg_temp.check_that('an editor reads the suggestions', v::integer >= 4, v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'),
    'select count(*)::text from meganet.equipment_suggestion');
  perform pg_temp.check_that('a stranger reads none', v = '0', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select count(*)::text from meganet.equipment_suggestion');
  perform pg_temp.check_that('anonymous cannot read them at all', v = 'ERROR 42501', v);
end
$$;

-- ── 6. Deciding ───────────────────────────────────────────────────────────────

do $$
declare
  v    text;
  v_id uuid := (select id from _ids where k = 's_logger');
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    perform pg_temp.check_that('no API roles — the administrator checks are skipped', true);
    return;
  end if;

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    format('select meganet.decide_equipment_suggestion(%L, ''approve'')::text', v_id));
  perform pg_temp.check_that('an editor who is not an administrator cannot approve', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    format('select meganet.decide_equipment_suggestion(%L, ''reject'')::text', v_id));
  perform pg_temp.check_that('…nor reject', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'former'),
    format('select meganet.decide_equipment_suggestion(%L, ''approve'')::text', v_id));
  perform pg_temp.check_that('…and nor can an administrator taken off the editors list', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
    format('select meganet.decide_equipment_suggestion(%L, ''approve'', ''read it myself'') -> ''suggestion'' ->> ''decided_by''', v_id));
  perform pg_temp.check_that('an administrator can, and is recorded as the one who did', v = 'review-admin@example.test', v);
end
$$;

do $$
declare
  v_id    uuid := (select id from _ids where k = 's_logger');
  v_id2   uuid := (select id from _ids where k = 's_logger2');
  v_out   jsonb;
  v_unit  uuid;
  v_new   uuid;
  v_s     jsonb;
  v_photo1 uuid := (select id from _ids where k = 'photo1');
  v_photo2 uuid := (select id from _ids where k = 'photo2');
  decide  text := 'select meganet.decide_equipment_suggestion(%L, %L, null, %L::jsonb)';
begin
  perform pg_temp.check_that('refuses a decision that is not approve or reject',
    pg_temp.state_of(format('select meganet.decide_equipment_suggestion(%L, ''maybe'')', v_id)) = '22023');
  perform pg_temp.check_that('refuses a suggestion that does not exist',
    pg_temp.state_of('select meganet.decide_equipment_suggestion(''00000000-0000-4000-8000-000000000999'', ''approve'')') = 'P0002');
  perform pg_temp.check_that('refuses a correction it does not take',
    pg_temp.state_of(format(decide, v_id, 'approve', '{"station_id":"_check_pr_b"}')) = '22023');
  perform pg_temp.check_that('refuses a correction to a kind the register does not know',
    pg_temp.state_of(format(decide, v_id, 'approve', '{"equipment_key":"flux_capacitor"}')) = '23503');
  perform pg_temp.check_that('refuses corrections that leave nothing to say',
    pg_temp.state_of(format(decide, v_id, 'approve', '{"make":"","model":"","serial_no":""}')) = '22023');

  -- Approved as proposed: a register that had no logger now has this one.
  v_out := meganet.decide_equipment_suggestion(v_id, 'approve', 'matches the label');
  v_unit := (v_out -> 'equipment' ->> 'id')::uuid;
  insert into _ids values ('u_logger', v_unit);
  perform pg_temp.check_that('approved as proposed, the logger is on the register — read off a photo, and which one',
    v_out -> 'equipment' ->> 'station_id' = '_check_pr_a' and v_out -> 'equipment' ->> 'equipment_key' = 'logger'
    and v_out -> 'equipment' ->> 'model' = 'CR300' and v_out -> 'equipment' ->> 'serial_no' = '12345'
    and v_out -> 'equipment' ->> 'source' = 'photo' and (v_out -> 'equipment' ->> 'photo_id')::uuid = v_photo1
    and (v_out -> 'equipment' ->> 'suggestion_id')::uuid = v_id and v_out -> 'equipment' ->> 'retired_at' is null, v_out::text);
  perform pg_temp.check_that('…the suggestion says approved, by whom, with the note, pointing at the row it wrote',
    v_out -> 'suggestion' ->> 'status' = 'approved' and v_out -> 'suggestion' ->> 'decision_note' = 'matches the label'
    and coalesce(v_out -> 'suggestion' ->> 'decided_by', '') <> '' and (v_out -> 'suggestion' ->> 'equipment_id')::uuid = v_unit
    and v_out -> 'suggestion' -> 'decision_patch' = 'null'::jsonb, v_out -> 'suggestion' ->> 'status');
  perform pg_temp.check_that('…and the same unit, waiting from the other photo, is superseded rather than asked about again',
    (v_out ->> 'superseded')::integer = 1
    and (select status from meganet.equipment_suggestion where id = v_id2) = 'superseded');
  perform pg_temp.check_that('deciding it twice is refused — two administrators, one answer',
    pg_temp.state_of(format('select meganet.decide_equipment_suggestion(%L, ''reject'')', v_id)) = '55000');
  perform pg_temp.check_that('the unit now on the register cannot be proposed again from anywhere',
    pg_temp.refusal_of(format('select meganet.propose_equipment(%L::jsonb)',
      pg_temp.proposal(jsonb_build_object('photo_id', v_photo2, 'serial_no', '12 345')))) = '23505/' || v_unit);

  -- A new logger read at the same station: the old one was replaced.
  v_s := meganet.propose_equipment(pg_temp.proposal(jsonb_build_object('photo_id', v_photo2, 'model', 'CR310', 'serial_no', '23456')));
  -- …but the OCR misread a digit, and the administrator puts it right first.
  v_out := meganet.decide_equipment_suggestion((v_s ->> 'id')::uuid, 'approve', 'the label says 23458',
                                               '{"serial_no":"23458","note":"swapped after the storm"}'::jsonb);
  v_new := (v_out -> 'equipment' ->> 'id')::uuid;
  perform pg_temp.check_that('approved with a correction: the register gets the corrected serial and the note',
    v_out -> 'equipment' ->> 'serial_no' = '23458' and v_out -> 'equipment' ->> 'model' = 'CR310'
    and v_out -> 'equipment' ->> 'note' = 'swapped after the storm', v_out::text);
  perform pg_temp.check_that('…the suggestion keeps what was proposed, and the correction beside it',
    v_out -> 'suggestion' ->> 'serial_no' = '23456'
    and v_out -> 'suggestion' -> 'decision_patch' = '{"serial_no":"23458","note":"swapped after the storm"}'::jsonb);
  perform pg_temp.check_that('…and the logger it replaced is retired, by whom, pointing at the new one',
    v_out -> 'retired' = jsonb_build_array(v_unit)
    and (select retired_at is not null and retired_by is not null and replaced_by = v_new
           from meganet.station_equipment where id = v_unit)
    and (select count(*) = 1 from meganet.station_equipment
          where station_id = '_check_pr_a' and equipment_key = 'logger' and retired_at is null));
end
$$;

do $$
declare
  v_mppt   uuid := (select id from _ids where k = 's_mppt');
  v_photo1 uuid := (select id from _ids where k = 'photo1');
  v_photo2 uuid := (select id from _ids where k = 'photo2');
  v_out    jsonb;
  v_s      jsonb;
  v_first  uuid;
  v_second uuid;
  v_n      integer;
  decide   text := 'select meganet.decide_equipment_suggestion(%L, %L, null, %L::jsonb)';
begin
  -- Rejected: nothing changes but the suggestion.
  select count(*) into v_n from meganet.station_equipment where station_id = '_check_pr_a';
  v_out := meganet.decide_equipment_suggestion(v_mppt, 'reject', 'that is the neighbour''s regulator');
  perform pg_temp.check_that('rejected: the suggestion says so and why, and the register is as it was',
    v_out -> 'suggestion' ->> 'status' = 'rejected' and v_out -> 'suggestion' ->> 'decision_note' = 'that is the neighbour''s regulator'
    and (select count(*) from meganet.station_equipment where station_id = '_check_pr_a') = v_n
    and v_out -> 'suggestion' ->> 'equipment_id' is null);
  perform pg_temp.check_that('a rejection takes no corrections',
    pg_temp.state_of(format(decide, (select id from meganet.equipment_suggestion
                                       where status = 'pending' and model = 'BlueSolar MPPT 75/15' limit 1),
                            'reject', '{"model":"x"}')) = '22023');
  perform pg_temp.check_that('what was rejected is not proposed again from the same photo',
    pg_temp.refusal_of(format('select meganet.propose_equipment(%L::jsonb)',
      jsonb_build_object('photo_id', v_photo1, 'equipment_key', 'solar_regulator', 'model', 'SmartSolar MPPT 100/30',
                         'proposed_by', 'ocr'))) = '23505/' || v_mppt);

  -- Two solar panels, both added — the second alongside the first, said outright.
  v_s := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_panel',
    'model', '80 W', 'serial_no', 'SP-001', 'proposed_by', 'ocr'));
  v_first := (meganet.decide_equipment_suggestion((v_s ->> 'id')::uuid, 'approve') -> 'equipment' ->> 'id')::uuid;
  v_s := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_panel',
    'model', '80 W', 'serial_no', 'SP-002', 'proposed_by', 'ocr'));
  v_out := meganet.decide_equipment_suggestion((v_s ->> 'id')::uuid, 'approve', null, '{"replaces":null}'::jsonb);
  v_second := (v_out -> 'equipment' ->> 'id')::uuid;
  perform pg_temp.check_that('a second of a kind, added alongside the first because the administrator said so',
    v_out -> 'retired' = '[]'::jsonb
    and (select count(*) = 2 from meganet.station_equipment
          where station_id = '_check_pr_b' and equipment_key = 'solar_panel' and retired_at is null));

  v_s := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_panel',
    'model', '120 W', 'serial_no', 'SP-003', 'proposed_by', 'ocr'));
  perform pg_temp.check_that('a third, with two on the register and nothing to choose between them, is refused — asking which',
    pg_temp.state_of(format('select meganet.decide_equipment_suggestion(%L, ''approve'')', v_s ->> 'id')) = '22023',
    'a guess here retires the wrong panel');
  v_out := meganet.decide_equipment_suggestion((v_s ->> 'id')::uuid, 'approve', null,
                                               jsonb_build_object('replaces', v_first));
  perform pg_temp.check_that('…and, told which, retires that one and leaves the other',
    v_out -> 'retired' = jsonb_build_array(v_first)
    and (select retired_at is not null from meganet.station_equipment where id = v_first)
    and (select retired_at is null from meganet.station_equipment where id = v_second));
  perform pg_temp.check_that('refuses to replace a unit that is not live at this station',
    pg_temp.state_of(format(decide,
      (meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_panel',
         'serial_no', 'SP-004', 'proposed_by', 'ocr')) ->> 'id'),
      'approve', jsonb_build_object('replaces', v_first))) = '23503');

  -- A regulator on the register with no serial, then its serial read: the
  -- same unit, now with a serial — not a replacement.
  v_s := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_regulator',
    'make', 'Victron Energy', 'model', 'SmartSolar MPPT 100/30', 'proposed_by', 'ocr'));
  v_first := (meganet.decide_equipment_suggestion((v_s ->> 'id')::uuid, 'approve') -> 'equipment' ->> 'id')::uuid;
  v_s := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_regulator',
    'model', 'SmartSolar MPPT 100/30', 'serial_no', 'HQ2239ABCDE', 'proposed_by', 'ocr'));
  v_out := meganet.decide_equipment_suggestion((v_s ->> 'id')::uuid, 'approve');
  perform pg_temp.check_that('a unit whose serial was never known gets it when it is read — the same row, nothing retired',
    (v_out -> 'equipment' ->> 'id')::uuid = v_first and v_out -> 'equipment' ->> 'serial_no' = 'HQ2239ABCDE'
    and v_out -> 'equipment' ->> 'make' = 'Victron Energy' and v_out -> 'retired' = '[]'::jsonb, v_out::text);

  -- The register's one rule, underneath the functions.
  perform pg_temp.check_that('two live units of one kind with one serial at one station cannot exist',
    pg_temp.state_of(format('insert into meganet.station_equipment (station_id, equipment_key, serial_no, source)
                             values (''_check_pr_b'', ''solar_regulator'', ''hq2239-abcde'', ''manual'')')) = '23505');
  perform pg_temp.check_that('…and replaces is not a way round it',
    pg_temp.refusal_of(format(decide,
      (meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_b', 'equipment_key', 'solar_regulator',
         'serial_no', 'HQ2239ZZZZZ', 'proposed_by', 'ocr')) ->> 'id'),
      'approve', '{"serial_no":"HQ2239ABCDE","replaces":null}')) = '23505/' || v_first);

  -- A suggestion for a station deleted since.
  v_s := meganet.propose_equipment(jsonb_build_object('station_id', '_check_pr_a', 'equipment_key', 'antenna',
    'make', 'RFI', 'serial_no', 'ANT-9', 'proposed_by', 'ocr'));
  update meganet.station set deleted_at = now() where id = '_check_pr_a';
  perform pg_temp.check_that('refuses to approve for a station deleted since it was proposed',
    pg_temp.state_of(format('select meganet.decide_equipment_suggestion(%L, ''approve'')', v_s ->> 'id')) = '23503');
  update meganet.station set deleted_at = null where id = '_check_pr_a';
end
$$;

do $$
declare
  v text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    return;
  end if;

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select count(*)::text from meganet.station_equipment where station_id = ''_check_pr_b'' and retired_at is null');
  perform pg_temp.check_that('an editor reads the register', v = '3', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'stranger'),
    'select count(*)::text from meganet.station_equipment');
  perform pg_temp.check_that('a stranger reads none of it', v = '0', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select count(*)::text from meganet.station_equipment');
  perform pg_temp.check_that('anonymous cannot read it at all', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
    'select count(*)::text from meganet.field_photo_outcome');
  perform pg_temp.check_that('the vocabularies are anybody''s', v = '6', v);
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
