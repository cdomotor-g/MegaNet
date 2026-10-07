-- check_field_photos.sql — Prove the field photo door (0035), against a real
-- database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_field_photos.sql
--
-- Every check below is one claim the head of 0035_field_photos.sql makes, or
-- one rule its three functions enforce. The whole script runs inside a
-- transaction and rolls back, so it is safe against the live database: nothing
-- it writes survives, including the placeholder stations it measures the
-- station matcher against and the editor it signs in as.
--
-- It needs to be run as a role meganet.is_editor() says yes to — a direct
-- psql connection, or one holding the service key. It prints a row per check
-- and exits non-zero if any of them failed. CI runs it on every push that
-- touches db/ or tools/, after every migration has been applied from zero
-- (.github/workflows/web-smoke.yml, the db-checks job).
--
-- What it deliberately does not check: the bucket and its policies, which are
-- tools/storage_bucket.sql's own verdict (and CI runs that too), and the
-- browser's half — which object path it sends, and that it takes the bytes
-- down again when this refuses — which is test/photos.mjs's.

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

-- The SQLSTATE a statement raised, or 'ok'. A refusal is only worth anything if
-- it is the right refusal.
create or replace function pg_temp.state_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- Run one query as another role with the claims a request would carry, and
-- say what it returned — then roll the role back, because `set local role`
-- would otherwise outlive the block for the rest of this transaction. The
-- answer comes out through the exception that does the rolling back.
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

-- A well-formed photo for the checks that are not about well-formedness. A
-- fresh uuid and a fresh hash every time, so none of them collides with
-- another by accident.
create or replace function pg_temp.photo(p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
           'storage_path', 'photo/' || u || '.jpg',
           'thumb_path',   'photo/' || u || '.thumb.jpg',
           'content_type', 'image/jpeg',
           'byte_size',    2163393,
           'sha256',       encode(sha256(convert_to(u, 'UTF8')), 'hex'),
           'title',        'IMG_0042.jpg',
           'width',        2576,
           'height',       1932) || p_extra
    from (select gen_random_uuid()::text as u) g;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Three stations in the Tasman Sea, where no real one is: two 300 m and 600 m
-- from a point, and a nearer one that has been soft-deleted — which the
-- matcher must never pick. And an editor to sign in as.

insert into meganet.rm_system (id, ord, name)
values (-983, -983, 'check_field_photos placeholder')
on conflict (id) do nothing;

-- The point: 30.5° S, 160.0° E. A metre of latitude is 1/110574 of a degree;
-- a metre of longitude there, 1/(111320 cos 30.5°).
insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon) values
  ('_check_fp_near', -983, 'Check Photo Near', '998350', -983, -30.5 + 300 / 110574.0, 160.0),
  ('_check_fp_far',  -984, 'Check Photo Far',  '998351', -983, -30.5, 160.0 + 600 / (111320 * cos(radians(30.5)))),
  ('_check_fp_gone', -985, 'Check Photo Gone', '998352', -983, -30.5 + 50 / 110574.0, 160.0)
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_fp_gone';

insert into meganet.editor_allow (entry, note)
values ('photo-editor@example.test', 'check_field_photos — rolled back'),
       ('photo-unconfirmed@example.test', 'check_field_photos — rolled back')
on conflict (entry) do nothing;

-- Since 0054 an editor is proven by auth.users, not by the token's claims: the
-- token's sub must be a user whose address is confirmed. The second user is
-- allowed but has not confirmed, so the allow list alone must not let it in.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000f0e01', 'photo-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000f0e02', 'photo-unconfirmed@example.test', null)
on conflict (id) do nothing;

create temporary table _ids (k text primary key, id uuid, sha text) on commit drop;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
declare
  v_fns text[] := array['add_field_photo', 'update_field_photo', 'remove_field_photo', 'field_photo_station_for'];
  t     text;
begin
  perform pg_temp.check_that('schema_version is at least 35',
    (select value::integer >= 35 from meganet.app_meta where key = 'schema_version'));

  foreach t in array array['field_photo', 'field_photo_origin', 'field_photo_placement',
                           'field_photo_sync', 'field_photo_sync_cursor'] loop
    perform pg_temp.check_that(format('meganet.%s exists with RLS on', t),
      (select relrowsecurity from pg_catalog.pg_class where oid = to_regclass('meganet.' || t)),
      'db/README.md: no table without RLS, in the same file');
  end loop;

  perform pg_temp.check_that('the cursor has RLS and no policy at all — service_role only',
    not exists (select 1 from pg_catalog.pg_policy where polrelid = 'meganet.field_photo_sync_cursor'::regclass));

  perform pg_temp.check_that('all four functions exist',
    (select count(distinct p.proname) = 4 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname = any(v_fns)));

  perform pg_temp.check_that('the three writers are security definer',
    (select bool_and(p.prosecdef) from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname = any(v_fns[1:3])));

  -- 0035's two ways in, at least: 0036 adds a third (gdrive), and any later
  -- sync is an insert, so the count is not the claim — the two rows are.
  perform pg_temp.check_that('the two vocabularies are seeded',
    (select count(*) = 2 from meganet.field_photo_origin where key in ('upload', 'dropbox'))
    and (select count(*) = 5 from meganet.field_photo_placement));
end
$$;

-- ── 2. The grants: read by editors, written only through the functions ───────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('no authenticator role — the grant checks are skipped', true);
    return;
  end if;

  perform pg_temp.check_that('authenticated may only SELECT meganet.field_photo',
    has_table_privilege('authenticated', 'meganet.field_photo', 'select')
    and not has_table_privilege('authenticated', 'meganet.field_photo', 'insert')
    and not has_table_privilege('authenticated', 'meganet.field_photo', 'update')
    and not has_table_privilege('authenticated', 'meganet.field_photo', 'delete'),
    'db/README.md: nothing is writable by anon or authenticated; the ways in are functions');

  perform pg_temp.check_that('anon may read the vocabularies and nothing else here',
    has_table_privilege('anon', 'meganet.field_photo_origin', 'select')
    and has_table_privilege('anon', 'meganet.field_photo_placement', 'select')
    and not has_table_privilege('anon', 'meganet.field_photo', 'select')
    and not has_table_privilege('anon', 'meganet.field_photo_sync', 'select'),
    'a photo''s position is as much a disclosure as its pixels');

  perform pg_temp.check_that('no browser role may read the sync cursor',
    not has_table_privilege('anon', 'meganet.field_photo_sync_cursor', 'select')
    and not has_table_privilege('authenticated', 'meganet.field_photo_sync_cursor', 'select'));

  perform pg_temp.check_that('an editor may run the three writers',
    has_function_privilege('authenticated', 'meganet.add_field_photo(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'meganet.update_field_photo(uuid, jsonb)', 'execute')
    and has_function_privilege('authenticated', 'meganet.remove_field_photo(uuid)', 'execute'));

  perform pg_temp.check_that('public holds EXECUTE on none of the four',
    not has_function_privilege('public', 'meganet.add_field_photo(jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.update_field_photo(uuid, jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.remove_field_photo(uuid)', 'execute')
    and not has_function_privilege('public', 'meganet.field_photo_station_for(numeric, numeric, numeric)', 'execute'),
    'db/README.md: a function that writes has its EXECUTE revoked from public, in the same file');
end
$$;

-- ── 3. The station a photo is of ─────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('the nearest live station within a kilometre',
    meganet.field_photo_station_for(-30.5, 160.0) = '_check_fp_near',
    coalesce(meganet.field_photo_station_for(-30.5, 160.0), '<null>'));

  perform pg_temp.check_that('a soft-deleted station is never the match, however near',
    meganet.field_photo_station_for(-30.5 + 50 / 110574.0, 160.0) = '_check_fp_near');

  perform pg_temp.check_that('nothing within the radius is no station, not the nearest anyway',
    meganet.field_photo_station_for(-30.5, 160.0, 200) is null
    and meganet.field_photo_station_for(-31.5, 160.0) is null);

  -- 290 m east of the near station and 290 m north of it: inside a 295 m
  -- radius and outside a 285 m one, in both directions — so a longitude
  -- scaled wrongly for the latitude (or not at all) fails one of the four.
  perform pg_temp.check_that('the radius is metres on the ground, east–west and north–south',
    meganet.field_photo_station_for((-30.5 + 300 / 110574.0)::numeric, (160.0 + 290 / (111320 * cos(radians(30.5))))::numeric, 295) = '_check_fp_near'
    and meganet.field_photo_station_for((-30.5 + 300 / 110574.0)::numeric, (160.0 + 290 / (111320 * cos(radians(30.5))))::numeric, 285) is null
    and meganet.field_photo_station_for((-30.5 + 590 / 110574.0)::numeric, 160.0, 295) = '_check_fp_near'
    and meganet.field_photo_station_for((-30.5 + 590 / 110574.0)::numeric, 160.0, 285) is null);

  perform pg_temp.check_that('no position, no station',
    meganet.field_photo_station_for(null, null) is null);
end
$$;

-- ── 4. Adding ─────────────────────────────────────────────────────────────────

do $$
declare
  v_in  jsonb;
  v_out jsonb;
begin
  v_in := pg_temp.photo(jsonb_build_object(
    'lat', -30.5, 'lon', 160.0, 'placement', 'ocr', 'accuracy_m', 4,
    'altitude_m', 134, 'altitude_ref', 'HAE', 'heading_deg', 242, 'heading_ref', 'T',
    'taken_at', '2026-06-24T12:26:08+10:00', 'taken_local', '2026-06-24T12:26:08', 'taken_source', 'ocr',
    'fov_deg', 67.3, 'meta', jsonb_build_object('ocr', jsonb_build_object('confidence', 'high'))));
  v_out := meganet.add_field_photo(v_in);
  insert into _ids values ('placed', (v_out ->> 'id')::uuid, v_in ->> 'sha256');

  perform pg_temp.check_that('a placed photo indexes, every field as sent',
    (v_out ->> 'lat')::numeric = -30.5 and (v_out ->> 'heading_deg')::numeric = 242
    and v_out ->> 'placement' = 'ocr' and v_out ->> 'altitude_ref' = 'HAE'
    and (v_out ->> 'taken_at')::timestamptz = '2026-06-24T02:26:08Z'
    and v_out ->> 'thumb_path' = v_in ->> 'thumb_path', v_out::text);

  perform pg_temp.check_that('…matched to the nearest station, and says it was by distance',
    v_out ->> 'station_id' = '_check_fp_near' and (v_out ->> 'station_auto')::boolean);

  perform pg_temp.check_that('…filed in the field-photos bucket, from the upload door, by the caller',
    v_out ->> 'storage_bucket' = 'field-photos' and v_out ->> 'origin' = 'upload'
    and coalesce(v_out ->> 'uploaded_by', '') <> '', v_out ->> 'uploaded_by');

  perform pg_temp.check_that('…and the file''s own name is the title, not the object''s',
    v_out ->> 'title' = 'IMG_0042.jpg' and v_out ->> 'storage_path' not like '%IMG_0042%');

  -- A photo nothing could place.
  v_in := pg_temp.photo();
  v_out := meganet.add_field_photo(v_in);
  insert into _ids values ('unplaced', (v_out ->> 'id')::uuid, v_in ->> 'sha256');
  perform pg_temp.check_that('an unplaced photo indexes, with no position, placement or station',
    v_out ->> 'lat' is null and v_out ->> 'placement' is null and v_out ->> 'station_id' is null
    and not (v_out ->> 'station_auto')::boolean, v_out::text);

  -- A station named by the sender wins over the nearest.
  v_out := meganet.add_field_photo(pg_temp.photo(jsonb_build_object(
    'lat', -30.5, 'lon', 160.0, 'placement', 'manual', 'station_id', '_check_fp_far')));
  insert into _ids values ('chosen', (v_out ->> 'id')::uuid, null);
  perform pg_temp.check_that('a station somebody chose is kept, and is not marked as by distance',
    v_out ->> 'station_id' = '_check_fp_far' and not (v_out ->> 'station_auto')::boolean);

  -- "No station", said out loud, is not the same as saying nothing.
  v_out := meganet.add_field_photo(pg_temp.photo(jsonb_build_object(
    'lat', -30.5, 'lon', 160.0, 'placement', 'manual', 'station_id', null)));
  perform pg_temp.check_that('a station sent as null means none — the nearest does not overrule it',
    v_out ->> 'station_id' is null and not (v_out ->> 'station_auto')::boolean, v_out ->> 'station_id');
end
$$;

-- ── 5. The same bytes twice, and the same Dropbox file twice ─────────────────

do $$
declare
  v_sha   text := (select sha from _ids where k = 'placed');
  v_first uuid := (select id from _ids where k = 'placed');
  v_state text;
  v_det   text;
  v_out   jsonb;
begin
  begin
    perform meganet.add_field_photo(pg_temp.photo(jsonb_build_object('sha256', v_sha)));
    v_state := 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_det = pg_exception_detail;
  end;
  perform pg_temp.check_that('the same bytes a second time are refused, naming the photo already here',
    v_state = '23505' and v_det = v_first::text, v_state || ' / ' || coalesce(v_det, ''));

  -- The Dropbox door: one row per Dropbox file id.
  v_out := meganet.add_field_photo(pg_temp.photo(jsonb_build_object('origin', 'dropbox', 'origin_ref', 'id:check-fp-1')));
  insert into _ids values ('dropbox', (v_out ->> 'id')::uuid, v_out ->> 'sha256');
  perform pg_temp.check_that('a Dropbox photo indexes with its origin and file id',
    v_out ->> 'origin' = 'dropbox' and v_out ->> 'origin_ref' = 'id:check-fp-1');

  perform pg_temp.check_that('the same Dropbox file a second time is refused, whatever its bytes',
    pg_temp.state_of(format('select meganet.add_field_photo(%L::jsonb)',
      pg_temp.photo(jsonb_build_object('origin', 'dropbox', 'origin_ref', 'id:check-fp-1')))) = '23505');

  perform pg_temp.check_that('refuses an origin that is not in the vocabulary',
    pg_temp.state_of(format('select meganet.add_field_photo(%L::jsonb)',
      pg_temp.photo(jsonb_build_object('origin', 'carrier-pigeon')))) = '23503');
end
$$;

-- ── 6. Every way adding has to refuse ────────────────────────────────────────
-- The path rules carry the security of a private bucket read through signed
-- URLs, and the rest keep a row from saying something about a photo that
-- cannot be true.

do $$
declare
  u text := gen_random_uuid()::text;
  refuse text;
begin
  refuse := 'select meganet.add_field_photo(%L::jsonb)';

  perform pg_temp.check_that('refuses a path outside photo/',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('storage_path', 'inspection/' || u || '.jpg', 'thumb_path', null)))) = '22023');
  perform pg_temp.check_that('refuses the camera''s own filename as the object name',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('storage_path', 'photo/IMG_0042.jpg', 'thumb_path', null)))) = '22023',
    'a guessable path is a guess away from the bytes');
  perform pg_temp.check_that('refuses an extension the content type does not arrive under',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('storage_path', 'photo/' || u || '.php', 'thumb_path', null)))) = '22023');
  perform pg_temp.check_that('refuses a thumbnail filed under another photo''s uuid',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('thumb_path', 'photo/' || u || '.thumb.jpg')))) = '22023');
  perform pg_temp.check_that('refuses something that is not a picture, though the attachment vocabulary lists it',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('content_type', 'application/pdf',
      'storage_path', 'photo/' || u || '.pdf', 'thumb_path', null)))) = '22023');
  perform pg_temp.check_that('refuses a picture over its type''s limit',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('byte_size', 99999999)))) = '22023');
  perform pg_temp.check_that('refuses a photo with no size',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('byte_size', null)))) = '22023');
  perform pg_temp.check_that('refuses a hash that is not a SHA-256',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('sha256', 'ABC123')))) = '22023');
  perform pg_temp.check_that('refuses half a position',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('lat', -27.5, 'placement', 'exif')))) = '22023');
  perform pg_temp.check_that('refuses a position off the Earth',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('lat', -127.5, 'lon', 152.2, 'placement', 'exif')))) = '23514');
  perform pg_temp.check_that('refuses a position that does not say where it came from',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('lat', -27.5, 'lon', 152.2)))) = '22023');
  perform pg_temp.check_that('refuses a placement that is not in the vocabulary',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('lat', -27.5, 'lon', 152.2, 'placement', 'guess')))) = '23503');
  perform pg_temp.check_that('refuses a placement with no position',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('placement', 'exif')))) = '22023');
  perform pg_temp.check_that('refuses a heading of 360 or more',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('heading_deg', 360)))) = '23514');
  perform pg_temp.check_that('refuses a station that does not exist',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('station_id', '_no_such_station')))) = '23503');
  perform pg_temp.check_that('refuses a station that has been soft-deleted',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('station_id', '_check_fp_gone')))) = '23503');
  perform pg_temp.check_that('refuses a key it does not know',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('colour', 'blue')))) = '22023');
  perform pg_temp.check_that('refuses meta that is not an object',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('meta', jsonb_build_array(1, 2))))) = '22023');
  perform pg_temp.check_that('refuses a time that is not a time',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('taken_at', 'last Tuesday-ish')))) = '22007');
  perform pg_temp.check_that('refuses an uploaded_by that is not the caller''s',
    pg_temp.state_of(format(refuse, pg_temp.photo(jsonb_build_object('uploaded_by', 'somebody.else@example.test')))) = '42501',
    'a field the client fills in is a field the client can forge');
end
$$;

-- ── 7. Who may add one ────────────────────────────────────────────────────────

do $$
declare
  v_res text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    perform pg_temp.check_that('no API roles — the sign-in checks are skipped', true);
    return;
  end if;

  v_res := pg_temp.as_role('anon', '{"role":"anon"}',
    format('select meganet.add_field_photo(%L::jsonb)::text', pg_temp.photo()));
  perform pg_temp.check_that('anonymous cannot add one', v_res like 'ERROR 42501', v_res);

  v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","email":"stranger@example.invalid"}',
    format('select meganet.add_field_photo(%L::jsonb)::text', pg_temp.photo()));
  perform pg_temp.check_that('a signed-in address that is not an editor cannot add one', v_res like 'ERROR 42501', v_res);

  v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000f0e01","email":"photo-editor@example.test"}',
    format('select meganet.add_field_photo(%L::jsonb) ->> %L', pg_temp.photo(), 'uploaded_by'));
  perform pg_temp.check_that('an editor can, and is recorded as the one who did', v_res = 'photo-editor@example.test', v_res);

  v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000f0e02","email":"photo-unconfirmed@example.test"}',
    format('select meganet.add_field_photo(%L::jsonb)::text', pg_temp.photo()));
  perform pg_temp.check_that('an allowed address that is not confirmed cannot (0054)', v_res like 'ERROR 42501', v_res);

  v_res := pg_temp.as_role('service_role', '{"role":"service_role"}',
    format('select meganet.add_field_photo(%L::jsonb) ->> %L',
      pg_temp.photo(jsonb_build_object('origin', 'dropbox', 'origin_ref', 'id:check-fp-sync',
                                       'uploaded_by', 'Dropbox — field@example.test')), 'uploaded_by'));
  perform pg_temp.check_that('the sync, as service_role, may say whose Dropbox a photo came from',
    v_res = 'Dropbox — field@example.test', v_res);
end
$$;

-- ── 8. Editing, moving, and what it will not touch ───────────────────────────

do $$
declare
  v_id  uuid := (select id from _ids where k = 'placed');
  v_ch  uuid := (select id from _ids where k = 'chosen');
  v_un  uuid := (select id from _ids where k = 'unplaced');
  v_out jsonb;
begin
  v_out := meganet.update_field_photo(v_id, '{"caption":"the gauge boards from the rock"}');
  perform pg_temp.check_that('a caption can be changed', v_out ->> 'caption' = 'the gauge boards from the rock');
  v_out := meganet.update_field_photo(v_id, '{"caption":""}');
  perform pg_temp.check_that('…and cleared, which a null argument could not say', v_out ->> 'caption' = '');

  -- Moved 700 m east: out of the near station's kilometre? No — 300 m north
  -- and 700 m east is 762 m from it, and 100 m from the far one.
  v_out := meganet.update_field_photo(v_id, jsonb_build_object(
    'lat', -30.5, 'lon', 160.0 + 700 / (111320 * cos(radians(30.5)))));
  perform pg_temp.check_that('moving a photo makes its placement manual and drops the GPS''s accuracy',
    v_out ->> 'placement' = 'manual' and v_out ->> 'accuracy_m' is null, v_out::text);
  perform pg_temp.check_that('…and a station picked by distance is picked again',
    v_out ->> 'station_id' = '_check_fp_far' and (v_out ->> 'station_auto')::boolean, v_out ->> 'station_id');
  perform pg_temp.check_that('…and who moved it is recorded',
    coalesce(v_out ->> 'updated_by', '') <> '');

  -- A photo that came in with no place, placed by hand 10 m from the near
  -- station: nobody can have filed it anywhere, so it is filed by distance,
  -- as it would have been had it arrived with the position.
  v_out := meganet.update_field_photo(v_un, jsonb_build_object('lat', -30.5 + 290 / 110574.0, 'lon', 160.0));
  perform pg_temp.check_that('an unplaced photo placed by hand is filed under the nearest station, by distance',
    v_out ->> 'placement' = 'manual' and v_out ->> 'station_id' = '_check_fp_near'
    and (v_out ->> 'station_auto')::boolean, v_out::text);

  v_out := meganet.update_field_photo(v_ch, jsonb_build_object('lat', -30.5 + 300 / 110574.0, 'lon', 160.0));
  perform pg_temp.check_that('a station somebody chose stays chosen when the photo moves',
    v_out ->> 'station_id' = '_check_fp_far' and not (v_out ->> 'station_auto')::boolean);

  v_out := meganet.update_field_photo(v_ch, '{"station_id":null}');
  perform pg_temp.check_that('a station can be cleared', v_out ->> 'station_id' is null);

  v_out := meganet.update_field_photo(v_ch, '{"lat":null,"lon":null}');
  perform pg_temp.check_that('a photo can be unplaced, placement and all',
    v_out ->> 'lat' is null and v_out ->> 'placement' is null);

  v_out := meganet.update_field_photo(v_ch, '{"taken_at":"2026-06-24T12:30:00+10:00"}');
  perform pg_temp.check_that('a time set by hand says it was', v_out ->> 'taken_source' = 'manual');

  perform pg_temp.check_that('refuses half a move',
    pg_temp.state_of(format('select meganet.update_field_photo(%L, ''{"lat":-30.4}'')', v_id)) = '22023');
  perform pg_temp.check_that('refuses a placement changed without the move it describes',
    pg_temp.state_of(format('select meganet.update_field_photo(%L, ''{"placement":"exif"}'')', v_id)) = '22023');
  perform pg_temp.check_that('refuses to move the bytes it points at',
    pg_temp.state_of(format('select meganet.update_field_photo(%L, ''{"storage_path":"photo/x.jpg"}'')', v_id)) = '22023');
  perform pg_temp.check_that('refuses to change the hash',
    pg_temp.state_of(format('select meganet.update_field_photo(%L, ''{"sha256":"00"}'')', v_id)) = '22023');
  perform pg_temp.check_that('refuses a station that does not exist',
    pg_temp.state_of(format('select meganet.update_field_photo(%L, ''{"station_id":"_no_such_station"}'')', v_id)) = '23503');
  perform pg_temp.check_that('refuses a photo that does not exist',
    pg_temp.state_of('select meganet.update_field_photo(''00000000-0000-4000-8000-000000000999'', ''{"caption":"x"}'')') = 'P0002');
  perform pg_temp.check_that('the path really did not move',
    (select storage_path from meganet.field_photo where id = v_id) like 'photo/%.jpg');
end
$$;

-- ── 9. Removing, and the tombstone ────────────────────────────────────────────

do $$
declare
  v_id  uuid := (select id from _ids where k = 'dropbox');
  v_sha text := (select sha from _ids where k = 'dropbox');
  v_out jsonb;
  v_res text;
begin
  v_out := meganet.remove_field_photo(v_id);
  perform pg_temp.check_that('removing returns both objects so the caller can delete the bytes',
    (v_out ->> 'removed')::boolean and v_out ->> 'storage_bucket' = 'field-photos'
    and v_out ->> 'storage_path' like 'photo/%' and v_out ->> 'thumb_path' like 'photo/%.thumb.jpg', v_out::text);

  perform pg_temp.check_that('…and the row stays, as a tombstone with who and when',
    exists (select 1 from meganet.field_photo where id = v_id and deleted_at is not null and deleted_by is not null));

  perform pg_temp.check_that('removing it again is not an error',
    (meganet.remove_field_photo(v_id) ->> 'removed')::boolean is false,
    'two people pressing Remove on one photo is a race with one right answer');

  perform pg_temp.check_that('a removed photo cannot be edited',
    pg_temp.state_of(format('select meganet.update_field_photo(%L, ''{"caption":"x"}'')', v_id)) = 'P0002');

  perform pg_temp.check_that('the sync cannot bring a removed Dropbox photo back',
    pg_temp.state_of(format('select meganet.add_field_photo(%L::jsonb)',
      pg_temp.photo(jsonb_build_object('origin', 'dropbox', 'origin_ref', 'id:check-fp-1')))) = '23505',
    'the tombstone keeps origin_ref');

  v_out := meganet.add_field_photo(pg_temp.photo(jsonb_build_object('sha256', v_sha)));
  perform pg_temp.check_that('…but the same bytes dropped in by hand may come back — a person doing that means it',
    v_out ->> 'id' is not null and v_out ->> 'origin' = 'upload');

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000f0e01","email":"photo-editor@example.test"}',
      format('select count(*)::text from meganet.field_photo where id = %L', v_id));
    perform pg_temp.check_that('an editor does not see the tombstone', v_res = '0', v_res);

    v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000f0e01","email":"photo-editor@example.test"}',
      format('select count(*)::text from meganet.field_photo where id = %L', (select id from _ids where k = 'unplaced')));
    perform pg_temp.check_that('…and does see a live photo', v_res = '1', v_res);

    v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","email":"stranger@example.invalid"}',
      'select count(*)::text from meganet.field_photo');
    perform pg_temp.check_that('a signed-in address that is not an editor sees no photo at all', v_res = '0', v_res);

    v_res := pg_temp.as_role('anon', '{"role":"anon"}', 'select count(*)::text from meganet.field_photo');
    perform pg_temp.check_that('anonymous cannot read the table at all', v_res = 'ERROR 42501', v_res);

    v_res := pg_temp.as_role('authenticated', '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000f0e01","email":"photo-editor@example.test"}',
      'select count(*)::text from meganet.field_photo_sync_cursor');
    perform pg_temp.check_that('not even an editor can read the sync''s cursor', v_res = 'ERROR 42501', v_res);
  end if;
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
