-- 0043_attachment_sha256.sql — The same file twice on one form is one file.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0043_attachment_sha256.sql
--
-- Field photos have refused duplicates since 0035: the browser hashes each file,
-- asks before sending its bytes, and a unique index over field_photo.sha256
-- holds when two people race. Attachments on inspection and maintenance forms
-- (0009, 0010) had nothing of the kind — picking the same photo twice, or two
-- people adding the same screenshot to one visit, stored the bytes twice.
--
-- This gives meganet.attachment the same guard:
--
--   1. attachment.sha256 — of the file as it arrived. Nullable, because rows
--      from before this file have none (the live index was empty when it was
--      written) and a hash cannot be worked out in SQL from bytes in Storage.
--   2. Two partial unique indexes, one per owner column: a hash is unique per
--      inspection and per maintenance activity. Per record rather than across
--      the database, deliberately — the same photo filed against a visit and
--      against the maintenance done on that visit is two true statements, not
--      a copy.
--   3. attach_file() restated with p_sha256 (default null, so a tab still
--      running the old app keeps working), refusing a duplicate with 23505 —
--      which PostgREST says as a 409 — naming the attachment already there.
--
-- The old ten-argument attach_file() is dropped rather than left beside the
-- new one: two overloads that differ by a defaulted argument make every named
-- call PostgREST sends ambiguous.

-- ── 1. The column ────────────────────────────────────────────────────────────

alter table meganet.attachment
  add column if not exists sha256 text;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'attachment_sha256_format'
                    and conrelid = 'meganet.attachment'::regclass) then
    alter table meganet.attachment
      add constraint attachment_sha256_format check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

comment on column meganet.attachment.sha256 is
  'SHA-256 of the file as it arrived, lower-case hex. Unique per inspection and per maintenance activity: the same bytes twice on one record is one file. Null on rows from before 0043.';

-- ── 2. Unique per record ─────────────────────────────────────────────────────

create unique index if not exists attachment_inspection_sha256_idx
  on meganet.attachment (inspection_id, sha256)
  where inspection_id is not null and sha256 is not null;
create unique index if not exists attachment_activity_sha256_idx
  on meganet.attachment (maintenance_activity_id, sha256)
  where maintenance_activity_id is not null and sha256 is not null;

-- ── 3. The door, restated ────────────────────────────────────────────────────
-- Everything 0010 said about it still holds; the only addition is the hash.

drop function if exists meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text);

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
         p_storage_bucket          text        default 'inspections',
         p_sha256                  text        default null)
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
  v_sha    text;
  v_dup    meganet.attachment%rowtype;
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

  -- The same bytes twice on one record is one file. Asked here, before the
  -- insert, so the refusal can name the one already there; the partial unique
  -- indexes below are what holds when two people race. A null hash is let
  -- through: an older tab that never sent one, or a browser with no SubtleCrypto.
  v_sha := nullif(p_sha256, '');
  if v_sha is not null then
    if v_sha !~ '^[0-9a-f]{64}$' then
      raise exception 'sha256 has to be 64 lower-case hex digits' using errcode = '22023';
    end if;
    select * into v_dup from meganet.attachment a
     where a.sha256 = v_sha
       and ((p_inspection_id is not null and a.inspection_id = p_inspection_id)
         or (p_maintenance_activity_id is not null and a.maintenance_activity_id = p_maintenance_activity_id))
     limit 1;
    if found then
      raise exception 'this file is already attached to this %', v_owner
        using errcode = '23505',
              detail  = v_dup.id::text,
              hint    = pg_catalog.format('as "%s", added by %s on %s',
                          coalesce(nullif(v_dup.title, ''), 'untitled'),
                          coalesce(nullif(v_dup.uploaded_by, ''), 'someone'),
                          pg_catalog.to_char(v_dup.created_at, 'YYYY-MM-DD'));
    end if;
  end if;

  -- Presentation order, worked out here rather than sent. The client would have
  -- to guess it from a list it may have loaded before somebody else uploaded.
  select coalesce(pg_catalog.max(a.ord), 0) + 1 into v_ord
    from meganet.attachment a
   where (p_inspection_id is not null and a.inspection_id = p_inspection_id)
      or (p_maintenance_activity_id is not null and a.maintenance_activity_id = p_maintenance_activity_id);

  insert into meganet.attachment (
      inspection_id, maintenance_activity_id, role_key, ord, title, caption,
      storage_bucket, storage_path, content_type, byte_size, taken_at, uploaded_by, sha256)
  values (
      p_inspection_id, p_maintenance_activity_id, p_role_key, v_ord,
      coalesce(p_title, ''), coalesce(p_caption, ''),
      'inspections', p_storage_path, p_content_type, p_byte_size, p_taken_at,
      meganet.actor(), v_sha)
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text, text) is
  'Index one object already uploaded to the inspections bucket, against an inspection or a maintenance activity. Editors only. Enforces the path convention, the type and size limits, refuses a file whose SHA-256 is already attached to the same record (0043), and stamps uploaded_by from the request rather than from the caller.';

revoke all on function meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text, text) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.attach_file(uuid, uuid, text, text, text, bigint, text, text, timestamptz, text, text)
    to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '43')
on conflict (key) do update set value = excluded.value;
