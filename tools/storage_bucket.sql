-- storage_bucket.sql — The `inspections` bucket and the four policies on it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/storage_bucket.sql
--
-- Unlike every other file under tools/ this one **writes**, and it does not roll
-- back. It is idempotent and safe to re-run: the bucket is an upsert and each
-- policy is dropped before it is created.
--
-- ── Why this is not a migration ──────────────────────────────────────────────
--
-- `storage.buckets` and `storage.objects` are Supabase's, not ours.
-- db/README.md records exactly one deliberate exception to "everything MegaNet
-- owns lives in `meganet`" — 0005's two triggers on `auth.users` — and calls it
-- load-bearing because catching a signup is impossible any other way. There is
-- no comparable argument for a bucket, so this stays out of db/migrations/ and
-- the schema version does not move when it runs.
--
-- ── Why it is a file at all ──────────────────────────────────────────────────
--
-- Because the alternative was tried and did not work. #145 asked a person to
-- create the bucket and paste the policies into the dashboard, in twelve
-- click-by-click steps. Its Part A (apply 0009) was done; its Part B was not;
-- the issue was closed as if both had been. Nothing said otherwise, because
-- nothing was watching — and #149 then found the bucket missing underneath a
-- feature that indexes objects into it.
--
-- A file can be re-run when you are not sure, diffed when it changes, and
-- checked at the foot. A dashboard click-path can only be remembered.
--
-- Run this once per project, after db/migrations/0010_attachments.sql. Applying
-- 0010 without it leaves the index able to record objects that have nowhere to
-- live; running this without 0010 leaves a bucket nothing writes to. Neither
-- order breaks anything, and the app says which half is missing.

\set ON_ERROR_STOP on

-- ── The bucket ───────────────────────────────────────────────────────────────
-- `public = false` is the whole point and is asserted again at the foot. A
-- public bucket serves every object to anyone holding the URL, no key and no
-- sign-in — and this bucket holds site photographs and, per the one filled-in
-- Council sheet in the workbook, screenshots of a canister's raw terminal config
-- dump. 0009 made every inspection *record* editors-only precisely because the
-- anon key is committed to this repo and served from GitHub Pages. A public
-- bucket would put the pictures outside the fence the tables are inside.
--
-- The limits mirror meganet.attachment_type: 25 MB is the largest per-type
-- limit there, and this is the backstop for a request that never reaches
-- meganet.attach_file(). The MIME list is left null deliberately — Storage
-- would reject on it before the app could say anything useful, and the app
-- refuses an unlisted type from attachment_type with a sentence instead.

insert into storage.buckets (id, name, public, file_size_limit)
values ('inspections', 'inspections', false, 26214400)
on conflict (id) do update set
  public          = false,
  file_size_limit = excluded.file_size_limit;

-- ── Who may read and write the objects ───────────────────────────────────────
-- Exactly the people meganet.is_editor() already allows — the same list as the
-- station editor and the same list as every inspection table, so there is one
-- list to take somebody off rather than three. is_editor() is `security
-- invoker` and granted to `authenticated` (0004, revised by 0007), and
-- meganet.email_allowed() underneath it is `security definer`, so the editors
-- list itself stays unreadable from here.
--
-- Four verbs rather than two: an update policy because Storage's upsert path
-- needs one, and a delete policy because meganet.detach_file() hands the caller
-- an object to remove and it must be able to.

drop policy if exists inspections_read_editors   on storage.objects;
drop policy if exists inspections_insert_editors on storage.objects;
drop policy if exists inspections_update_editors on storage.objects;
drop policy if exists inspections_delete_editors on storage.objects;

create policy inspections_read_editors on storage.objects
  for select to authenticated
  using (bucket_id = 'inspections' and meganet.is_editor());

create policy inspections_insert_editors on storage.objects
  for insert to authenticated
  with check (bucket_id = 'inspections' and meganet.is_editor());

create policy inspections_update_editors on storage.objects
  for update to authenticated
  using (bucket_id = 'inspections' and meganet.is_editor())
  with check (bucket_id = 'inspections' and meganet.is_editor());

create policy inspections_delete_editors on storage.objects
  for delete to authenticated
  using (bucket_id = 'inspections' and meganet.is_editor());

-- ── The verdict ──────────────────────────────────────────────────────────────
-- The three things #145's Part B could get wrong, asserted rather than eyeballed
-- in a dashboard: the bucket exists, it is private, and all four policies are
-- there. Raises rather than printing a row, so a scripted run fails loudly.

do $$
declare
  v_public   boolean;
  v_policies integer;
begin
  select public into v_public from storage.buckets where id = 'inspections';
  if v_public is null then
    raise exception 'the inspections bucket was not created';
  end if;
  if v_public then
    raise exception 'the inspections bucket is PUBLIC — every photo in it is served to anyone with the URL';
  end if;

  select count(*) into v_policies from pg_catalog.pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'inspections\_%';
  if v_policies <> 4 then
    raise exception 'expected 4 inspections_* policies on storage.objects, found %', v_policies;
  end if;

  raise notice 'the inspections bucket exists, is private, and has all 4 policies';
end
$$;
