-- check_attachments.sql — Prove the attachment door, against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_attachments.sql
--
-- Every check below is one line of #149's acceptance, or one claim the head of
-- 0010_attachments.sql makes. The whole script runs inside a transaction and
-- rolls back, so it is safe against the live database: nothing it writes
-- survives, including the placeholder station, inspection and maintenance
-- activity it needs to hang attachments off.
--
-- It needs to be run as a role meganet.is_editor() says yes to — a direct psql
-- connection, or one holding the service key. It prints a row per check and
-- exits non-zero if any of them failed.
--
-- Two things it deliberately does **not** check, because a database connection
-- cannot see them: whether the `inspections` bucket exists, and whether its four
-- policies do. That is tools/storage_bucket.sql's own verdict block, and it is
-- the half #145 got wrong — so it is asserted there, where it can be, rather
-- than assumed here.
--
-- Run it after applying 0010, and again after touching anything in it.

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

-- Did this statement raise, and with which SQLSTATE? Most of this file is about
-- a refusal, and a refusal is only worth anything if it is the *right* refusal.
create or replace function pg_temp.raises(p_sql text, p_sqlstate text default null)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return p_sqlstate is null or sqlstate = p_sqlstate;
end;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- One station, one inspection on it and one maintenance activity, so both sides
-- of the xor have a real owner. Rolled back either way; the ids are prefixed so
-- a half-committed accident is obvious.

insert into meganet.rm_system (id, ord, name)
values (-982, -982, 'check_attachments placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id)
values ('_check_att_site', -982, 'Check Attachment Site', '998010', -982)
on conflict (id) do nothing;

create temporary table _ids (
  inspection_id uuid,
  activity_id   uuid
) on commit drop;

do $$
declare
  v_insp uuid;
  v_act  uuid;
begin
  insert into meganet.inspection (station_id, config_key, station_name, inspected_on)
  values ('_check_att_site', 'alert', 'Check Attachment Site', current_date)
  returning id into v_insp;

  insert into meganet.maintenance_activity (station_id, station_name, visited_on)
  values ('_check_att_site', 'Check Attachment Site', current_date)
  returning id into v_act;

  insert into _ids values (v_insp, v_act);
end
$$;

-- A well-formed path for one of the two owners, with a fresh uuid leaf. Written
-- once here because every check below that is *not* about the path convention
-- needs a path that satisfies it.
create or replace function pg_temp.good_path(p_kind text, p_owner uuid, p_ext text default 'jpg')
returns text language sql as $$
  select p_kind || '/' || p_owner::text || '/' || gen_random_uuid()::text || '.' || p_ext;
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
declare
  v_fns text[] := array['attach_file', 'update_attachment', 'detach_file'];
begin
  -- At least 10, for the same reason check_inspections.sql says at least 9: a
  -- database carrying a later migration still carries this one. (That check was
  -- an equality until #115 found it had been failing on every live database
  -- since 0007 — worth not repeating.)
  perform pg_temp.check_that('schema_version is at least 10',
    (select value::integer >= 10 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('meganet.attachment_type exists',
    to_regclass('meganet.attachment_type') is not null);

  perform pg_temp.check_that('RLS is on for meganet.attachment_type',
    (select relrowsecurity from pg_catalog.pg_class
      where oid = 'meganet.attachment_type'::regclass),
    'db/README.md: no table without RLS, in the same file');

  perform pg_temp.check_that('meganet.attachment_type has a read policy',
    (select count(*) > 0 from pg_catalog.pg_policy
      where polrelid = 'meganet.attachment_type'::regclass));

  perform pg_temp.check_that('all three functions exist',
    (select count(distinct p.proname) = 3 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname = any(v_fns)));

  perform pg_temp.check_that('all three are security definer',
    (select bool_and(p.prosecdef) from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname = any(v_fns)));
end
$$;

-- ── 2. The grants, which are the whole reason this migration exists ──────────
-- #149's finding was that 0009 granted `select` and nothing else, so the RLS
-- insert policy underneath was unreachable. The fix is a function, not a grant —
-- so the assertion is that the table privilege is *still* absent and the
-- function privilege is present.

do $$
begin
  perform pg_temp.check_that('an editor may still only SELECT meganet.attachment',
    has_table_privilege('authenticated', 'meganet.attachment', 'select')
    and not has_table_privilege('authenticated', 'meganet.attachment', 'insert')
    and not has_table_privilege('authenticated', 'meganet.attachment', 'update')
    and not has_table_privilege('authenticated', 'meganet.attachment', 'delete'),
    'db/README.md: nothing is writable by anon or authenticated; the ways in are functions');

  perform pg_temp.check_that('an editor may run all three functions',
    has_function_privilege('authenticated',
      'meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text)', 'execute')
    and has_function_privilege('authenticated', 'meganet.update_attachment(uuid, jsonb)', 'execute')
    and has_function_privilege('authenticated', 'meganet.detach_file(uuid)', 'execute'));

  perform pg_temp.check_that('public holds EXECUTE on none of them',
    not has_function_privilege('public',
      'meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text)', 'execute')
    and not has_function_privilege('public', 'meganet.update_attachment(uuid, jsonb)', 'execute')
    and not has_function_privilege('public', 'meganet.detach_file(uuid)', 'execute'),
    'db/README.md: a function that writes has its EXECUTE revoked from public, in the same file');

  perform pg_temp.check_that('anon may read the type vocabulary and not the index',
    has_table_privilege('anon', 'meganet.attachment_type', 'select')
    and not has_table_privilege('anon', 'meganet.attachment', 'select'),
    'the list of what a blank form accepts is public; what is attached to a site is not');
end
$$;

-- ── 3. The type vocabulary ───────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('seven content types are seeded',
    (select count(*) >= 7 from meganet.attachment_type));

  perform pg_temp.check_that('every seeded type carries at least one extension and a limit',
    (select bool_and(array_length(extensions, 1) >= 1 and max_bytes > 0)
       from meganet.attachment_type));

  perform pg_temp.check_that('a text dump is limited far below a photo',
    (select max_bytes from meganet.attachment_type where content_type = 'text/plain')
    < (select max_bytes from meganet.attachment_type where content_type = 'image/jpeg'),
    'one limit generous enough for a phone photo is no limit at all on a terminal dump');

  perform pg_temp.check_that('no extension carries a dot',
    (select bool_and(e not like '%.%')
       from meganet.attachment_type, unnest(extensions) e));
end
$$;

-- ── 4. Attaching, on both sides of the xor ───────────────────────────────────

do $$
declare
  v_insp uuid;
  v_act  uuid;
  v_out  jsonb;
begin
  select inspection_id, activity_id into v_insp, v_act from _ids;

  v_out := meganet.attach_file(
    p_inspection_id => v_insp,
    p_role_key      => 'photo',
    p_storage_path  => pg_temp.good_path('inspection', v_insp),
    p_content_type  => 'image/jpeg',
    p_byte_size     => 120000,
    p_title         => 'IMG_0042.jpg');

  perform pg_temp.check_that('an inspection attachment indexes, and exactly one id is set',
    (v_out ->> 'inspection_id')::uuid = v_insp
    and v_out ->> 'maintenance_activity_id' is null,
    v_out::text);

  perform pg_temp.check_that('it is filed in the inspections bucket and attributed to the caller',
    v_out ->> 'storage_bucket' = 'inspections'
    and coalesce(v_out ->> 'uploaded_by', '') <> '',
    v_out ->> 'uploaded_by');

  perform pg_temp.check_that('the file''s own name is kept as the title, not as the object name',
    v_out ->> 'title' = 'IMG_0042.jpg'
    and v_out ->> 'storage_path' not like '%IMG_0042%');

  v_out := meganet.attach_file(
    p_maintenance_activity_id => v_act,
    p_role_key                => 'canister_config',
    p_storage_path            => pg_temp.good_path('maintenance', v_act, 'png'),
    p_content_type            => 'image/png',
    p_byte_size               => 90000);

  perform pg_temp.check_that('a maintenance attachment indexes, and exactly one id is set',
    (v_out ->> 'maintenance_activity_id')::uuid = v_act
    and v_out ->> 'inspection_id' is null,
    v_out::text);

  -- The order is worked out in the database rather than sent, so a second upload
  -- against the same record does not need the client to have a current list.
  v_out := meganet.attach_file(
    p_inspection_id => v_insp,
    p_storage_path  => pg_temp.good_path('inspection', v_insp),
    p_content_type  => 'image/jpeg',
    p_byte_size     => 5000);

  perform pg_temp.check_that('ord is assigned server-side and increments per record',
    (v_out ->> 'ord')::integer = 2, v_out ->> 'ord');
end
$$;

-- ── 5. Every way it has to refuse ────────────────────────────────────────────
-- The path rules are the security-carrying half of this migration: a private
-- bucket read through signed URLs is only as private as its paths are
-- unguessable.

do $$
declare
  v_insp uuid;
  v_act  uuid;
  v_ok   text;
begin
  select inspection_id, activity_id into v_insp, v_act from _ids;
  v_ok := pg_temp.good_path('inspection', v_insp);

  perform pg_temp.check_that('refuses an object filed under another record''s prefix',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_insp, pg_temp.good_path('inspection', v_act)), '22023'));

  perform pg_temp.check_that('refuses the camera''s own filename as the object name',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_insp, 'inspection/' || v_insp::text || '/IMG_0042.jpg'), '22023'),
    'a guessable path under a known record id is a guess away from the bytes');

  perform pg_temp.check_that('refuses a path with no prefix at all',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => ''loose.jpg'',
              p_content_type => ''image/jpeg'', p_byte_size => 100)', v_insp), '22023'));

  perform pg_temp.check_that('refuses an extension the content type does not arrive under',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_insp, pg_temp.good_path('inspection', v_insp, 'php')), '22023'));

  perform pg_temp.check_that('refuses a content type that is not in the vocabulary',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''application/x-msdownload'', p_byte_size => 100)',
      v_insp, pg_temp.good_path('inspection', v_insp, 'exe')), '22023'));

  perform pg_temp.check_that('refuses a file over the limit for its type',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''text/plain'', p_byte_size => 99999999)',
      v_insp, pg_temp.good_path('inspection', v_insp, 'txt')), '22023'));

  perform pg_temp.check_that('refuses a file with no size',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'')',
      v_insp, pg_temp.good_path('inspection', v_insp)), '22023'));

  perform pg_temp.check_that('refuses a role that is not in meganet.attachment_role',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_role_key => ''selfie'',
              p_storage_path => %L, p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_insp, v_ok), '23503'));

  perform pg_temp.check_that('refuses both owners at once',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_maintenance_activity_id => %L,
              p_storage_path => %L, p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_insp, v_act, v_ok), '22023'));

  perform pg_temp.check_that('refuses neither owner',
    pg_temp.raises(
      'select meganet.attach_file(p_storage_path => ''inspection/x/y.jpg'',
              p_content_type => ''image/jpeg'', p_byte_size => 100)', '22023'));

  perform pg_temp.check_that('refuses a bucket that is not the inspections one',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'', p_byte_size => 100,
              p_storage_bucket => ''public'')', v_insp, v_ok), '22023'));

  perform pg_temp.check_that('refuses an inspection that does not exist',
    pg_temp.raises(
      'select meganet.attach_file(p_inspection_id => ''00000000-0000-4000-8000-000000000999'',
              p_storage_path => ''inspection/00000000-0000-4000-8000-000000000999/'
      || '11111111-1111-4111-8111-111111111111.jpg'',
              p_content_type => ''image/jpeg'', p_byte_size => 100)', '23503'));
end
$$;

-- A soft-deleted record is still a row, so the foreign key would happily accept
-- it. Nothing renders it, though, which makes an attachment filed against one a
-- photo nobody will ever see again.
do $$
declare
  v_act uuid;
begin
  select activity_id into v_act from _ids;
  update meganet.maintenance_activity set deleted_at = now() where id = v_act;

  perform pg_temp.check_that('refuses a record that has been soft-deleted',
    pg_temp.raises(format(
      'select meganet.attach_file(p_maintenance_activity_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_act, pg_temp.good_path('maintenance', v_act)), '23503'));

  update meganet.maintenance_activity set deleted_at = null where id = v_act;
end
$$;

-- ── 6. The unique index over (bucket, path) ──────────────────────────────────

do $$
declare
  v_insp uuid;
  v_path text;
begin
  select inspection_id into v_insp from _ids;
  v_path := pg_temp.good_path('inspection', v_insp);

  perform meganet.attach_file(
    p_inspection_id => v_insp, p_storage_path => v_path,
    p_content_type => 'image/jpeg', p_byte_size => 100);

  perform pg_temp.check_that('the same object cannot be claimed twice',
    pg_temp.raises(format(
      'select meganet.attach_file(p_inspection_id => %L, p_storage_path => %L,
              p_content_type => ''image/jpeg'', p_byte_size => 100)',
      v_insp, v_path), '23505'));
end
$$;

-- ── 7. Editing, and what it will not edit ────────────────────────────────────

do $$
declare
  v_insp uuid;
  v_id   uuid;
  v_out  jsonb;
  v_path text;
begin
  select inspection_id into v_insp from _ids;
  v_path := pg_temp.good_path('inspection', v_insp);
  v_out := meganet.attach_file(
    p_inspection_id => v_insp, p_storage_path => v_path,
    p_content_type => 'image/jpeg', p_byte_size => 100, p_caption => 'first go');
  v_id := (v_out ->> 'id')::uuid;

  v_out := meganet.update_attachment(v_id, '{"caption":"the gate, from the road"}'::jsonb);
  perform pg_temp.check_that('a caption can be changed',
    v_out ->> 'caption' = 'the gate, from the road');

  v_out := meganet.update_attachment(v_id, '{"caption":""}'::jsonb);
  perform pg_temp.check_that('a caption can be cleared, which a null argument could not express',
    v_out ->> 'caption' = '',
    'this is why it is a patch and not a set of named arguments');

  v_out := meganet.update_attachment(v_id, '{"role_key":"gauge_board"}'::jsonb);
  perform pg_temp.check_that('the role can be changed to another real role',
    v_out ->> 'role_key' = 'gauge_board');

  perform pg_temp.check_that('refuses a role that is not real',
    pg_temp.raises(format(
      'select meganet.update_attachment(%L, ''{"role_key":"selfie"}''::jsonb)', v_id), '23503'));

  perform pg_temp.check_that('refuses to move the object it points at',
    pg_temp.raises(format(
      'select meganet.update_attachment(%L, ''{"storage_path":"inspection/x/y.jpg"}''::jsonb)',
      v_id), '22023'),
    'editing it here would only ever make the index disagree with the bucket');

  perform pg_temp.check_that('refuses to re-owner an attachment',
    pg_temp.raises(format(
      'select meganet.update_attachment(%L, ''{"inspection_id":null}''::jsonb)', v_id), '22023'));

  perform pg_temp.check_that('the path really did not move',
    (select storage_path from meganet.attachment where id = v_id) = v_path);
end
$$;

-- ── 8. Detaching ─────────────────────────────────────────────────────────────

do $$
declare
  v_insp uuid;
  v_id   uuid;
  v_path text;
  v_out  jsonb;
begin
  select inspection_id into v_insp from _ids;
  v_path := pg_temp.good_path('inspection', v_insp);
  v_id := (meganet.attach_file(
    p_inspection_id => v_insp, p_storage_path => v_path,
    p_content_type => 'image/jpeg', p_byte_size => 100) ->> 'id')::uuid;

  v_out := meganet.detach_file(v_id);
  perform pg_temp.check_that('detaching returns the object so the caller can delete the bytes',
    (v_out ->> 'removed')::boolean
    and v_out ->> 'storage_path' = v_path
    and v_out ->> 'storage_bucket' = 'inspections',
    v_out::text);

  perform pg_temp.check_that('the index row is gone',
    not exists (select 1 from meganet.attachment where id = v_id));

  v_out := meganet.detach_file(v_id);
  perform pg_temp.check_that('detaching something already detached is not an error',
    (v_out ->> 'removed')::boolean is false,
    'two people pressing Remove on the same photo is a race with one right answer');
end
$$;

-- ── 9. The documents carry them ──────────────────────────────────────────────
-- 0009's two doc functions already aggregate `attachments`; this is the first
-- migration under which that array is ever non-empty, so it is worth asserting
-- rather than assuming.

do $$
declare
  v_insp uuid;
  v_act  uuid;
begin
  select inspection_id, activity_id into v_insp, v_act from _ids;

  perform pg_temp.check_that('inspection_doc() returns the attachments, in ord order',
    (select count(*) from jsonb_array_elements(meganet.inspection_doc(v_insp) -> 'attachments')) >= 3
    and (select bool_and(ok) from (
          select (value ->> 'ord')::integer >= lag((value ->> 'ord')::integer, 1, 0)
                 over (order by ordinality) as ok
            from jsonb_array_elements(meganet.inspection_doc(v_insp) -> 'attachments')
                 with ordinality) s));

  perform pg_temp.check_that('maintenance_activity_doc() returns its own, and only its own',
    (select count(*) from jsonb_array_elements(
       meganet.maintenance_activity_doc(v_act) -> 'attachments')) = 1);

  perform pg_temp.check_that('neither document leaks the other''s owner column',
    not (meganet.inspection_doc(v_insp) -> 'attachments' -> 0 ? 'inspection_id')
    and not (meganet.maintenance_activity_doc(v_act) -> 'attachments' -> 0 ? 'maintenance_activity_id'),
    'the owner is the document; repeating it in every child is noise');
end
$$;

-- ── 10. Cascade ──────────────────────────────────────────────────────────────
-- A hard delete of the parent takes the index rows with it (0009's `on delete
-- cascade`). The objects are not ours to cascade, which is worth knowing rather
-- than discovering: a hard delete leaves the bytes behind.

do $$
declare
  v_insp uuid;
  v_n    integer;
begin
  select inspection_id into v_insp from _ids;
  select count(*) into v_n from meganet.attachment where inspection_id = v_insp;

  delete from meganet.inspection where id = v_insp;

  perform pg_temp.check_that(
    format('deleting the parent takes its %s index rows with it', v_n),
    v_n > 0 and not exists (select 1 from meganet.attachment where inspection_id = v_insp),
    'the objects in the bucket are not cascaded — a hard delete leaves the bytes');
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
