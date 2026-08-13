-- 0010_attachments.sql — The door for attachments, which 0009 built the index for.
--
-- Issue #149, sub-issue of #78. 0009 created `meganet.attachment` complete —
-- the xor over the two owner columns, the role vocabulary, the unique index over
-- (bucket, path) — and then granted `authenticated` nothing but `select` on it.
-- So a signed-in editor could read the index and could not add to it: the
-- editors-only RLS insert policy 0009 wrote is unreachable, because the table
-- privilege underneath it was never granted. Neither save function writes
-- attachments either, deliberately.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0010_attachments.sql
--
-- ── Why three functions and not `grant insert` ───────────────────────────────
--
-- Granting `insert, delete` on meganet.attachment to `authenticated` is one line
-- and the RLS policies are already there to gate it. It is still the wrong
-- answer, and db/README.md says why in a sentence that would stop being true:
--
--   "Nothing is *writable* by `anon` or by `authenticated`: no table grants
--    either of them a write verb, and the only ways in are the functions above."
--
-- That is not a stylistic preference. Three of the things this row has to be
-- true about cannot be expressed as a column constraint, because they are facts
-- about the *request* rather than about the row:
--
--   · the object path has to agree with the owner it is filed under, or the
--     index and the bucket drift apart and neither can be cleaned up from the
--     other;
--   · the leaf name has to be one the app generated rather than one a phone
--     supplied, because a private bucket read through a signed URL is only as
--     private as its paths are unguessable — `IMG_0042.jpg` under a known
--     inspection id is a guess away;
--   · `uploaded_by` has to be the caller, not whatever the caller typed.
--
-- A grant hands all three to the client. So: one door in, one door out, one for
-- the caption — the same shape as 0004's station writes and 0009's own.
--
-- ── What this file deliberately does not do ──────────────────────────────────
--
-- It does not create the bucket, and it does not write the policies on
-- `storage.objects` that let an editor put bytes there. `storage` is Supabase's
-- schema, and db/README.md records exactly one load-bearing exception to
-- "everything MegaNet owns lives in `meganet`" — 0005's triggers on `auth.users`,
-- which exist because there is no other way to catch a signup. There is another
-- way here, so this is not a second exception.
--
-- What #145 learned the hard way is that "do it in the dashboard" is not a plan:
-- its Part A was applied and its Part B was not, the issue was closed, and the
-- bucket this file's paths point into does not exist. So the bucket and its four
-- policies are now a file — `tools/storage_bucket.sql`, run the same way as
-- `tools/check_inspections.sql`, idempotent, with a verification query at the
-- foot. Not a migration, because it is not ours to migrate; not a click-path
-- either.

-- ── What may be attached ─────────────────────────────────────────────────────
-- 0009 has the vocabulary for *what an attachment is for* (`attachment_role`:
-- photo, canister_config, gauge_board, document, other). This is the other axis
-- — what a file may be — and it is a table for the reason `ingest_source` is a
-- table: adding HEIC when the crew's phones start producing it should be an
-- insert, not a migration.
--
-- It carries the size limit per type rather than one limit for all of them,
-- because the two things being attached here are not alike: a phone photo of a
-- gauge board is megabytes and a pasted terminal dump is kilobytes, and a single
-- limit generous enough for the first is no limit at all on the second.
--
-- Public, like every other vocabulary in this domain: it is the list of what a
-- blank form will accept and says nothing about any site. The browser reads it
-- to build the file picker's `accept=` list and to refuse a file *before*
-- spending a minute of a paddock's worth of signal uploading it.

create table if not exists meganet.attachment_type (
  content_type text primary key,
  ord          integer not null default 0,
  label        text    not null,
  extensions   text[]  not null,
  max_bytes    bigint  not null,

  constraint attachment_type_has_extensions check (pg_catalog.array_length(extensions, 1) >= 1),
  constraint attachment_type_max_bytes_sane check (max_bytes > 0 and max_bytes <= 104857600)
);

comment on table meganet.attachment_type is
  'What may be uploaded, and how large. A vocabulary rather than a check constraint so a new camera format is an insert. Public: it describes a blank form, not a site.';
comment on column meganet.attachment_type.extensions is
  'Every filename extension this type is allowed to arrive under, lower case, no dot. meganet.attach_file() checks the object path against this list, so a .php named as an image is refused at the index rather than left in the bucket.';

insert into meganet.attachment_type (content_type, ord, label, extensions, max_bytes) values
  ('image/jpeg', 1, 'JPEG photo',   array['jpg', 'jpeg'], 25165824),
  ('image/png',  2, 'PNG image',    array['png'],         25165824),
  ('image/webp', 3, 'WebP image',   array['webp'],        25165824),
  ('image/heic', 4, 'HEIC photo',   array['heic'],        25165824),
  ('image/heif', 5, 'HEIF photo',   array['heif'],        25165824),
  ('application/pdf', 6, 'PDF document', array['pdf'],    26214400),
  ('text/plain', 7, 'Text file',    array['txt', 'log'],  1048576)
on conflict (content_type) do update set
  ord = excluded.ord, label = excluded.label,
  extensions = excluded.extensions, max_bytes = excluded.max_bytes;

-- ── The three doors ──────────────────────────────────────────────────────────

-- Index one object that is already in the bucket.
--
-- The bytes go up first, over the Storage API, as the signed-in editor — that
-- request is gated by the policies in tools/storage_bucket.sql and never comes
-- through here. This is the second half: it records that the object exists, what
-- it is of, and who put it there.
--
-- Upload-then-index rather than index-then-upload, and the order is a choice
-- between two failures. An index row whose object never arrived renders as a
-- broken thumbnail on a form somebody is relying on; an object no row points at
-- is invisible and costs a few kilobytes until someone sweeps the bucket. The
-- second is the better failure, so the row is written last and the caller
-- deletes the object again if this refuses it.
create or replace function meganet.attach_file(
         p_inspection_id           uuid        default null,
         p_maintenance_activity_id uuid        default null,
         p_role_key                text        default 'photo',
         p_storage_path            text        default null,
         p_content_type            text        default null,
         p_byte_size               bigint      default null,
         p_title                   text        default '',
         p_caption                 text        default '',
         p_taken_at                timestamptz default null,
         p_storage_bucket          text        default 'inspections')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type   meganet.attachment_type%rowtype;
  v_owner  text;
  v_prefix text;
  v_leaf   text;
  v_ext    text;
  v_ord    integer;
  v_row    meganet.attachment%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to attach files'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  -- Exactly one owner, and it has to be a record that is still there. The table
  -- constraint already refuses both-or-neither; this is the half a constraint
  -- cannot see, which is that the parent is not soft-deleted. Attaching a photo
  -- to a deleted visit would file it where nothing will ever render it.
  if (p_inspection_id is not null) = (p_maintenance_activity_id is not null) then
    raise exception 'an attachment belongs to exactly one of an inspection or a maintenance activity'
      using errcode = '22023';
  end if;

  if p_inspection_id is not null then
    if not exists (select 1 from meganet.inspection
                    where id = p_inspection_id and deleted_at is null) then
      raise exception 'no such inspection: %', p_inspection_id using errcode = '23503';
    end if;
    v_owner  := 'inspection';
    v_prefix := 'inspection/' || p_inspection_id::text || '/';
  else
    if not exists (select 1 from meganet.maintenance_activity
                    where id = p_maintenance_activity_id and deleted_at is null) then
      raise exception 'no such maintenance activity: %', p_maintenance_activity_id using errcode = '23503';
    end if;
    v_owner  := 'maintenance';
    v_prefix := 'maintenance/' || p_maintenance_activity_id::text || '/';
  end if;

  if coalesce(p_storage_bucket, '') <> 'inspections' then
    raise exception 'attachments live in the `inspections` bucket, not %', p_storage_bucket
      using errcode = '22023';
  end if;

  if not exists (select 1 from meganet.attachment_role where key = p_role_key) then
    raise exception '% is not an attachment role', p_role_key
      using errcode = '23503',
            hint    = 'see meganet.attachment_role';
  end if;

  select * into v_type from meganet.attachment_type where content_type = p_content_type;
  if not found then
    raise exception '% is not a content type this app accepts', coalesce(p_content_type, '(none)')
      using errcode = '22023',
            hint    = 'see meganet.attachment_type — adding one is an insert, not a migration';
  end if;

  if p_byte_size is null or p_byte_size <= 0 then
    raise exception 'an attachment needs its size in bytes' using errcode = '22023';
  end if;
  if p_byte_size > v_type.max_bytes then
    raise exception '% is %.1f MB and the limit for % is %.1f MB',
      coalesce(nullif(p_title, ''), p_storage_path),
      p_byte_size / 1048576.0, v_type.label, v_type.max_bytes / 1048576.0
      using errcode = '22023';
  end if;

  -- The path. Two things are being enforced and they are different: the prefix
  -- keeps the index and the bucket navigable from either end, and the leaf keeps
  -- the object unguessable. A private bucket is read through signed URLs, and a
  -- signed URL is only ever as private as the path it signs — a camera's own
  -- filename under a known record id is a name somebody can try.
  if p_storage_path is null or pg_catalog.left(p_storage_path, pg_catalog.length(v_prefix)) <> v_prefix then
    raise exception 'the object path for this % has to start with %', v_owner, v_prefix
      using errcode = '22023';
  end if;

  v_leaf := pg_catalog.substr(p_storage_path, pg_catalog.length(v_prefix) + 1);
  if v_leaf !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$' then
    raise exception 'the object name has to be a generated uuid and an extension, not %', v_leaf
      using errcode = '22023',
            hint    = 'the app names the object; the file''s own name goes in title';
  end if;

  v_ext := pg_catalog.split_part(v_leaf, '.', 2);
  if not (v_ext = any (v_type.extensions)) then
    raise exception '% is not an extension % arrives under (%)',
      v_ext, v_type.label, pg_catalog.array_to_string(v_type.extensions, ', ')
      using errcode = '22023';
  end if;

  -- Presentation order, worked out here rather than sent. The client would have
  -- to guess it from a list it may have loaded before somebody else uploaded.
  select coalesce(pg_catalog.max(a.ord), 0) + 1 into v_ord
    from meganet.attachment a
   where (p_inspection_id is not null and a.inspection_id = p_inspection_id)
      or (p_maintenance_activity_id is not null and a.maintenance_activity_id = p_maintenance_activity_id);

  insert into meganet.attachment (
      inspection_id, maintenance_activity_id, role_key, ord, title, caption,
      storage_bucket, storage_path, content_type, byte_size, taken_at, uploaded_by)
  values (
      p_inspection_id, p_maintenance_activity_id, p_role_key, v_ord,
      coalesce(p_title, ''), coalesce(p_caption, ''),
      'inspections', p_storage_path, p_content_type, p_byte_size, p_taken_at,
      meganet.actor())
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text) is
  'Index one object already uploaded to the inspections bucket, against an inspection or a maintenance activity. Editors only. Enforces the path convention, the type and size limits, and stamps uploaded_by from the request rather than from the caller.';

-- Change what an attachment says about itself — never what or where it is.
--
-- A patch rather than a full row, and a patch rather than named arguments,
-- because "set the caption to nothing" and "leave the caption alone" are
-- different instructions and a null argument cannot be both. The key list is
-- closed: `storage_path`, `content_type`, `byte_size` and the two owner columns
-- describe an object that is already in the bucket, and editing them here would
-- only ever make the index disagree with it.
create or replace function meganet.update_attachment(p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  meganet.attachment%rowtype;
  v_key  text;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to edit attachments' using errcode = '42501';
  end if;

  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'meganet.update_attachment() needs a JSON object' using errcode = '22023';
  end if;

  for v_key in select pg_catalog.jsonb_object_keys(p_patch) loop
    if v_key not in ('title', 'caption', 'ord', 'role_key', 'taken_at') then
      raise exception 'meganet.update_attachment() does not change %', v_key
        using errcode = '22023',
              hint    = 'title, caption, ord, role_key and taken_at are the whole list';
    end if;
  end loop;

  if p_patch ? 'role_key'
     and not exists (select 1 from meganet.attachment_role
                      where key = p_patch ->> 'role_key') then
    raise exception '% is not an attachment role', p_patch ->> 'role_key' using errcode = '23503';
  end if;

  update meganet.attachment a
     set title    = case when p_patch ? 'title'    then coalesce(p_patch ->> 'title', '')   else a.title end,
         caption  = case when p_patch ? 'caption'  then coalesce(p_patch ->> 'caption', '') else a.caption end,
         ord      = case when p_patch ? 'ord'      then coalesce((p_patch ->> 'ord')::integer, a.ord) else a.ord end,
         role_key = case when p_patch ? 'role_key' then p_patch ->> 'role_key' else a.role_key end,
         taken_at = case when p_patch ? 'taken_at' then (nullif(p_patch ->> 'taken_at', ''))::timestamptz else a.taken_at end
   where a.id = p_id
  returning * into v_row;

  if not found then
    raise exception 'no such attachment: %', p_id using errcode = 'P0002';
  end if;
  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.update_attachment(uuid, jsonb) is
  'Edit an attachment''s title, caption, order, role or taken_at. A patch, so clearing a caption and leaving it alone are different requests. Never touches the object it points at.';

-- Drop the index row, and say which object is now unreferenced.
--
-- The bytes are not this function's to delete — they are in Supabase's schema,
-- reached over the Storage API by the same session, under the policies in
-- tools/storage_bucket.sql. So this returns the bucket and path and the caller
-- removes the object next. Same reasoning as attach_file()'s ordering: if the
-- second half fails, an orphaned object is a cheaper wrong state than an index
-- row pointing at nothing.
create or replace function meganet.detach_file(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.attachment%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to remove attachments' using errcode = '42501';
  end if;

  delete from meganet.attachment where id = p_id returning * into v_row;
  if not found then
    -- Not an error. Two people pressing Remove on the same photo is a race with
    -- one right answer — the photo is gone — and raising here would make the
    -- second person's form say something failed when nothing did.
    return pg_catalog.jsonb_build_object('removed', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'storage_bucket', v_row.storage_bucket,
    'storage_path', v_row.storage_path);
end;
$$;

comment on function meganet.detach_file(uuid) is
  'Remove one attachment from the index and return the object it pointed at, so the caller can delete the bytes. Removing something already removed is not an error.';

-- ── Row level security ───────────────────────────────────────────────────────
-- One new table, RLS in the same file — db/README.md, and nothing catches it for
-- us outside `public`. This is a vocabulary, so it reads like the other twelve:
-- public select, no write policy for anybody a browser can reach.

alter table meganet.attachment_type enable row level security;

drop policy if exists attachment_type_read_all on meganet.attachment_type;
create policy attachment_type_read_all on meganet.attachment_type
  for select using (true);

-- ── Who may run what ─────────────────────────────────────────────────────────
-- All three write, so all three have EXECUTE revoked from public and granted
-- back by name. Note what is *not* here: no new grant on meganet.attachment
-- itself. `authenticated` keeps exactly the `select` 0009 gave it, and the three
-- functions above are the only way a browser reaches the other three verbs.

revoke all on function meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text) from public;
revoke all on function meganet.update_attachment(uuid, jsonb)                                                   from public;
revoke all on function meganet.detach_file(uuid)                                                                from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Said out loud rather than left as an absence, and re-said every time this
  -- file runs. 0009 never granted these, so on a clean database this revoke
  -- changes nothing — which is the point: "the browser cannot write this table"
  -- is the property the three functions above exist to preserve, and a property
  -- that holds only because nobody has typed a `grant` yet is one a re-apply
  -- cannot restore. tools/check_attachments.sql asserts it; this is what makes
  -- the assertion something a re-run can put right.
  revoke insert, update, delete, truncate on meganet.attachment from anon, authenticated;

  grant select on meganet.attachment_type to anon, authenticated;
  grant select, insert, update, delete on meganet.attachment_type to service_role;

  grant execute on function meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text)
    to authenticated, service_role;
  grant execute on function meganet.update_attachment(uuid, jsonb) to authenticated, service_role;
  grant execute on function meganet.detach_file(uuid)              to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '10')
on conflict (key) do update set value = excluded.value;
