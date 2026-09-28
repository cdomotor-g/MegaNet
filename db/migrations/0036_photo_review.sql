-- 0036_photo_review.sql — What became of every photo that was sent, and what
-- the photos show: the equipment standing at a station, read off its labels,
-- proposed, and believed only once an administrator has said yes.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0036_photo_review.sql
--
-- Four things, in one file because the Field Photos tab's Review panel reads
-- all of them and none is much use without the others:
--
--   1. meganet.field_photo_upload — a row per file per attempt, from every way
--      in (the tab, the Dropbox sync, the Google Drive sync), saying what
--      became of it. Until now an upload's outcome lived in one browser's
--      memory and died with the tab, and a sync's in a workflow log nobody
--      opens: "did my 40 photos go in?" had no answer anywhere a person looks.
--   2. meganet.is_admin() — the first thing to read meganet.app_user.role,
--      which 0005 created "to decide nothing yet". It decides one thing here:
--      who may turn a suggestion into a fact.
--   3. meganet.station_equipment — the station's equipment register: what is
--      fitted there now, make, model and serial, and what it replaced.
--   4. meganet.equipment_suggestion — changes to that register proposed by the
--      OCR reading a photo's labels, by a person, or (later) by an agent, each
--      waiting for an administrator's decision.
--
-- ── Why suggestions and not writes ────────────────────────────────────────────
--
-- A serial number read off a photo by OCR is a reading, the same way a
-- position read off an overlay is (0035): one reading in six of an overlay had
-- a digit wrong, and a label is smaller, dirtier and shot at an angle. So the
-- register is never written by what read the photo. It is written by
-- decide_equipment_suggestion(), which only an administrator may call, and
-- which takes the administrator's corrections with the approval. What was
-- proposed, by what, on what evidence, and what the decision changed stay on
-- the suggestion row, so how often the reader is right is a query rather than
-- an impression.
--
-- propose_equipment() is the seam. The tab's OCR calls it today, as the signed
-- in editor who pressed the button, with proposed_by 'ocr'. An agent — a
-- model reading the photos, or a script reading the inspection history — calls
-- the same function with the service key and proposed_by 'agent:<its name>',
-- and its proposals wait in the same queue for the same decision. Giving an
-- agent that key, or a role of its own, is a person's decision and is not
-- made here (docs/field-photos.md, "The agent seam").
--
-- ── Who may see them ──────────────────────────────────────────────────────────
--
-- Editors, and nobody holding only the anon key — the same answer 0035 gives
-- for the photos, for a sharper reason: serial numbers have so far only ever
-- been written into inspection records, which are editors-only (0009), and an
-- equipment register is a shopping list for anyone who would rather take a
-- radio than buy one. The upload log names files and who sent them. The
-- vocabularies are public, as every vocabulary here is.

-- ── One more way in ───────────────────────────────────────────────────────────
-- Google Drive, for the sync that reads a shared Drive folder the way
-- tools/field-photos reads Dropbox. The vocabulary is 0035's; the sync's report
-- row (meganet.field_photo_sync, source 'gdrive') and its photos
-- (origin 'gdrive', origin_ref the Drive file id) need nothing else.

insert into meganet.field_photo_origin (key, ord, label) values
  ('gdrive', 3, 'Imported from Google Drive by the sync')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- ── 1. What became of each file ───────────────────────────────────────────────

create table if not exists meganet.field_photo_outcome (
  key        text    primary key,
  ord        integer not null,
  label      text    not null,
  -- Whether a file with this outcome is a photo in MegaNet — and so whether a
  -- log row with it may, and should, point at one.
  has_photo  boolean not null default false
);

comment on table meganet.field_photo_outcome is
  'What became of a file sent to MegaNet. Public: it describes the outcomes, not any file. has_photo says whether a file with this outcome is a photo in MegaNet now.';

insert into meganet.field_photo_outcome (key, ord, label, has_photo) values
  ('imported',  1, 'In MegaNet now, placed where it was taken', true),
  ('unplaced',  2, 'In MegaNet now, but nothing could place it', true),
  ('duplicate', 3, 'Already in MegaNet: the same bytes, or the same file from the same folder', true),
  ('skipped',   4, 'Left alone: not a photo, or removed from MegaNet before', false),
  ('refused',   5, 'Refused: not a photo MegaNet stores, too large, damaged, or turned down by the database', false),
  ('failed',    6, 'The upload did not finish — sending it again may work', false)
on conflict (key) do update set ord = excluded.ord, label = excluded.label, has_photo = excluded.has_photo;

-- One row per file per attempt. An attempt is one press of Upload on the tab,
-- or one run of a sync: batch_id is the same for every file in it, so "what did
-- that upload do" is one query. The same file sent twice is two rows — the
-- second saying duplicate — because the log is of what happened, not of what
-- is true now; field_photo is what is true now.
--
-- Kept for review, not for ever: the Review panel reads the last two hundred,
-- and meganet.prune_field_photo_uploads() below takes rows older than half a
-- year when somebody runs it. Nothing runs it on a schedule — at the rate
-- photos arrive (a few hundred a month) the table grows by a few megabytes a
-- year, and a schedule is a thing to maintain; the index on attempted_at is
-- what keeps both the panel and the prune cheap in the meantime.
create table if not exists meganet.field_photo_upload (
  id            uuid        primary key default gen_random_uuid(),
  attempted_at  timestamptz not null default now(),
  origin        text        not null references meganet.field_photo_origin (key),
  batch_id      uuid        not null,

  -- The file as the person or the folder named it, and the zip it came out of
  -- when it came in a pack.
  file_name     text        not null,
  archive_name  text,
  sha256        text,
  byte_size     bigint,

  outcome       text        not null references meganet.field_photo_outcome (key),
  reason        text        not null default '',

  -- The photo the file became, or already was; the station it was filed under.
  photo_id      uuid        references meganet.field_photo (id) on delete set null,
  station_id    text        references meganet.station (id) on delete set null,

  uploaded_by   text        not null default '',

  constraint field_photo_upload_named     check (pg_catalog.length(file_name) between 1 and 300),
  constraint field_photo_upload_archive   check (archive_name is null or pg_catalog.length(archive_name) between 1 and 300),
  constraint field_photo_upload_sha256    check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint field_photo_upload_size      check (byte_size is null or byte_size >= 0),
  constraint field_photo_upload_reason    check (pg_catalog.length(reason) <= 1000)
);

comment on table meganet.field_photo_upload is
  'One row per file per attempt to bring it into MegaNet — the tab''s Upload, the Dropbox sync, the Google Drive sync — and what became of it. Written only through meganet.log_field_photo_upload(); read by editors on the Field Photos tab''s Review panel. Kept for review, not for ever: meganet.prune_field_photo_uploads().';
comment on column meganet.field_photo_upload.batch_id is
  'The same for every file in one press of Upload or one run of a sync.';
comment on column meganet.field_photo_upload.photo_id is
  'The photo this file became (imported, unplaced) or already was (duplicate). Null for a file that did not get in — meganet.field_photo_outcome.has_photo says which outcomes those are.';

create index if not exists field_photo_upload_when_idx    on meganet.field_photo_upload (attempted_at desc);
create index if not exists field_photo_upload_batch_idx   on meganet.field_photo_upload (batch_id);
create index if not exists field_photo_upload_outcome_idx on meganet.field_photo_upload (outcome, attempted_at desc);
create index if not exists field_photo_upload_photo_idx   on meganet.field_photo_upload (photo_id) where photo_id is not null;

-- Write a batch of outcomes. A JSON array rather than a row per call, because
-- the tab writes a batch when an upload finishes and the sync one per run, and
-- five hundred round trips for a folder is a slow way to say what happened.
-- Bounded — five hundred rows a call, a thousand characters a reason — so a
-- caller in a loop cannot fill the table by accident.
--
-- All or nothing, like every function here: a row this refuses refuses the
-- batch, and says which row. The callers treat the log as best-effort — a
-- refused log never fails an upload — so a refusal costs a gap in the log,
-- which the tab says it has, rather than a photo.
--
-- Closed key list, for add_field_photo()'s reason. attempted_at and
-- uploaded_by are the server's own — now, and the caller — except that the
-- syncs, which run as service_role, say when they handled each file and whose
-- folder it came out of.
create or replace function meganet.log_field_photo_upload(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n        integer;
  v_i        integer;
  v_row      jsonb;
  v_key      text;
  v_actor    text := meganet.actor();
  v_sync     boolean;
  v_default  uuid := gen_random_uuid();
  v_batch    uuid;
  v_origin   text;
  v_outcome  meganet.field_photo_outcome%rowtype;
  v_name     text;
  v_archive  text;
  v_sha      text;
  v_size     bigint;
  v_photo    uuid;
  v_station  text;
  v_at       timestamptz;
  v_by       text;
  v_where    text;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write the upload log'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'meganet.log_field_photo_upload() needs a JSON array of rows' using errcode = '22023';
  end if;
  v_n := pg_catalog.jsonb_array_length(p_rows);
  if v_n = 0 then
    return pg_catalog.jsonb_build_object('logged', 0);
  end if;
  if v_n > 500 then
    raise exception 'that is % rows, and the log takes at most 500 in one call — send the rest in another', v_n
      using errcode = '22023';
  end if;

  v_sync := v_actor = 'service_role';

  for v_i in 0 .. v_n - 1 loop
    v_row := p_rows -> v_i;
    v_where := pg_catalog.format('row %s of %s', v_i + 1, v_n);
    if pg_catalog.jsonb_typeof(v_row) <> 'object' then
      raise exception '%: each row is a JSON object', v_where using errcode = '22023';
    end if;
    for v_key in select pg_catalog.jsonb_object_keys(v_row) loop
      if v_key not in ('batch_id', 'origin', 'file_name', 'archive_name', 'sha256', 'byte_size',
                       'outcome', 'reason', 'photo_id', 'station_id', 'attempted_at', 'uploaded_by') then
        raise exception '%: the upload log does not take %', v_where, v_key using errcode = '22023';
      end if;
    end loop;

    begin
      v_batch := coalesce(nullif(v_row ->> 'batch_id', '')::uuid, v_default);
    exception when others then
      raise exception '%: batch_id has to be a uuid, not %', v_where, v_row ->> 'batch_id' using errcode = '22023';
    end;

    v_origin := coalesce(nullif(v_row ->> 'origin', ''), 'upload');
    if not exists (select 1 from meganet.field_photo_origin where key = v_origin) then
      raise exception '%: % is not a way in for a field photo', v_where, v_origin using errcode = '23503',
        hint = 'see meganet.field_photo_origin';
    end if;

    v_name := pg_catalog.btrim(coalesce(v_row ->> 'file_name', ''));
    if v_name = '' then
      raise exception '%: a row needs the file''s name', v_where using errcode = '22023';
    end if;
    v_name := pg_catalog.left(v_name, 300);
    v_archive := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(v_row ->> 'archive_name', '')), ''), 300);

    v_sha := nullif(v_row ->> 'sha256', '');
    if v_sha is not null and v_sha !~ '^[0-9a-f]{64}$' then
      raise exception '%: sha256 has to be 64 lower-case hex digits', v_where using errcode = '22023';
    end if;

    begin
      v_size := (v_row ->> 'byte_size')::bigint;
    exception when others then
      raise exception '%: byte_size has to be a whole number of bytes', v_where using errcode = '22023';
    end;
    if v_size is not null and v_size < 0 then
      raise exception '%: byte_size cannot be negative', v_where using errcode = '22023';
    end if;

    select * into v_outcome from meganet.field_photo_outcome where key = v_row ->> 'outcome';
    if not found then
      raise exception '%: % is not an outcome the log knows', v_where, coalesce(v_row ->> 'outcome', '(none)')
        using errcode = '23503', hint = 'see meganet.field_photo_outcome';
    end if;

    begin
      v_photo := nullif(v_row ->> 'photo_id', '')::uuid;
    exception when others then
      raise exception '%: photo_id has to be a uuid', v_where using errcode = '22023';
    end;
    if v_photo is not null then
      if not v_outcome.has_photo then
        raise exception '%: a file that was % did not get into MegaNet, so it has no photo to point at', v_where, v_outcome.key
          using errcode = '22023';
      end if;
      if not exists (select 1 from meganet.field_photo where id = v_photo) then
        raise exception '%: no such field photo: %', v_where, v_photo using errcode = '23503';
      end if;
    end if;

    v_station := nullif(v_row ->> 'station_id', '');
    if v_station is not null and not exists (select 1 from meganet.station where id = v_station) then
      raise exception '%: no such station: %', v_where, v_station using errcode = '23503';
    end if;

    -- When and who: the server's, except for the syncs.
    v_at := pg_catalog.now();
    if v_row ? 'attempted_at' then
      if not v_sync then
        raise exception '%: attempted_at is the server''s clock, not something to send', v_where using errcode = '42501';
      end if;
      begin
        v_at := coalesce(nullif(v_row ->> 'attempted_at', '')::timestamptz, v_at);
      exception when others then
        raise exception '%: attempted_at is not a time: %', v_where, v_row ->> 'attempted_at' using errcode = '22007';
      end;
    end if;
    v_by := v_actor;
    if nullif(v_row ->> 'uploaded_by', '') is not null then
      if v_sync then
        v_by := pg_catalog.left(v_row ->> 'uploaded_by', 200);
      elsif v_row ->> 'uploaded_by' <> v_actor then
        raise exception '%: uploaded_by is the caller''s, not something to send', v_where using errcode = '42501';
      end if;
    end if;

    insert into meganet.field_photo_upload (
        attempted_at, origin, batch_id, file_name, archive_name, sha256, byte_size,
        outcome, reason, photo_id, station_id, uploaded_by)
    values (
        v_at, v_origin, v_batch, v_name, v_archive, v_sha, v_size,
        v_outcome.key, pg_catalog.left(coalesce(v_row ->> 'reason', ''), 1000), v_photo, v_station, v_by);
  end loop;

  return pg_catalog.jsonb_build_object('logged', v_n, 'batch_id', v_default);
end;
$$;

comment on function meganet.log_field_photo_upload(jsonb) is
  'Record what became of up to 500 files sent to MegaNet, all or nothing. Editors and the syncs (service_role, which may also say when and whose). Best-effort for its callers: a refused log never fails an upload.';

-- Take the old rows out. Six months by default; never less than a week, so a
-- slip of the finger cannot empty the table somebody is reviewing.
create or replace function meganet.prune_field_photo_uploads(p_older_than interval default interval '180 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator may prune the upload log' using errcode = '42501';
  end if;
  if p_older_than is null or p_older_than < interval '7 days' then
    raise exception 'the upload log keeps at least a week — % is shorter than that', coalesce(p_older_than::text, 'nothing')
      using errcode = '22023';
  end if;
  delete from meganet.field_photo_upload where attempted_at < pg_catalog.now() - p_older_than;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function meganet.prune_field_photo_uploads(interval) is
  'Delete upload log rows older than the interval (default 180 days, at least 7). Administrators and service_role; nothing runs it on a schedule.';

-- ── 2. Who is an administrator ────────────────────────────────────────────────
-- 0005 keyed meganet.app_user on the auth.users id — the join a primary key,
-- not an email match — so this asks for the caller's own row by auth.uid().
-- An administrator is an editor first: an address taken off editor_allow loses
-- its administration with its editing, without anybody having to remember that
-- there was a second list.
--
-- The same shape as is_editor(): anon never; the service key always (it is the
-- owner's, and what an agent or a sync would hold); a direct connection is the
-- owner at a psql prompt, with nothing here to get around. The role is read
-- from the `role` GUC for 0004's reason — inside a definer function
-- current_user is the owner, and would wave everybody through.
--
-- How the owner makes somebody an administrator — after they have signed in
-- once, which is what creates their app_user row — is one statement, in
-- docs/field-photos.md:
--
--   update meganet.app_user set role = 'admin' where lower(email) = lower('someone@example.org');
create or replace function meganet.is_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  v_role text;
begin
  claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_role := coalesce(nullif(pg_catalog.current_setting('role', true), 'none'),
                     claims ->> 'role',
                     current_user::text);

  if v_role in ('anon', 'authenticator') then
    return false;
  end if;
  if v_role = 'service_role' then
    return true;
  end if;
  if v_role = 'authenticated' then
    if not meganet.is_editor() then
      return false;
    end if;
    return exists (select 1 from meganet.app_user u where u.id = auth.uid() and u.role = 'admin');
  end if;
  return true;
end;
$$;

comment on function meganet.is_admin() is
  'May the current request decide what is believed — approve equipment suggestions, prune the upload log? Anon never; service_role always; authenticated when it is an editor and its meganet.app_user row says role = ''admin''. The first reader of app_user.role (0005).';

comment on table meganet.app_user is
  'One row per signed-in person, provisioned by trigger from auth.users. role = ''admin'' is read by meganet.is_admin() (0036); ''viewer'' is recorded and not yet enforced — meganet.is_editor() still asks meganet.editor_allow.';
comment on column meganet.app_user.role is
  'viewer | editor | admin. admin is read by meganet.is_admin() (0036): an editor who may approve equipment suggestions. viewer is still recorded and not enforced — meganet.is_editor() asks meganet.editor_allow. Everyone is provisioned editor; the owner grants admin with an update (docs/field-photos.md).';

-- ── 3. What a station has fitted ──────────────────────────────────────────────

-- How a register entry was known. A table for 0035's reason: the next source
-- (a barcode scan, a supplier's delivery note) is an insert.
create table if not exists meganet.equipment_source (
  key    text    primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.equipment_source is
  'How an entry on a station''s equipment register was known. Public, like the other vocabularies.';

insert into meganet.equipment_source (key, ord, label) values
  ('photo',      1, 'Read off a field photo''s labels, and approved'),
  ('inspection', 2, 'From an inspection record''s serial numbers'),
  ('manual',     3, 'Proposed by a person, and approved'),
  ('agent',      4, 'Proposed by an agent, and approved')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- Two serials are the same serial when their letters and digits are, in
-- either case: `SN 1234-A` on the label, `1234a` on a form. Used by the
-- register's uniqueness and by every match below, so they cannot disagree.
create or replace function meganet.equipment_serial_key(p_serial text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_serial, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

comment on function meganet.equipment_serial_key(text) is
  'A serial number as the register compares it: its letters and digits, upper-cased. ''SN 1234-a'' and ''1234A'' are one serial only after the SN label is gone — the reader takes labels off; this takes the punctuation.';

-- What identifies a unit in a suggestion when there is no serial to go by:
-- its model. So a photo showing two different solar panels with no readable
-- serial can propose both, and the same photo cannot propose the same one twice.
create or replace function meganet.equipment_identity(p_serial text, p_model text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when meganet.equipment_serial_key(p_serial) <> ''
              then 'sn:' || meganet.equipment_serial_key(p_serial)
              else 'model:' || meganet.equipment_serial_key(p_model) end;
$$;

comment on function meganet.equipment_identity(text, text) is
  'The serial (as equipment_serial_key compares it) or, when there is none, the model — what tells two proposals of one kind apart.';

-- The register. One row per unit ever known to be at a station; the live ones
-- are those with no retired_at. A unit that is replaced is retired, not
-- deleted, and says what replaced it — "what was here before the logger that
-- is here now" is the question a fault history asks.
--
-- A station can have two of a kind — two solar panels, a primary and a spare
-- water level sensor — so (station, kind) is not unique. A serial is: one live
-- unit per serial, per kind, per station.
create table if not exists meganet.station_equipment (
  id             uuid        primary key default gen_random_uuid(),
  station_id     text        not null references meganet.station (id) on delete cascade,
  equipment_key  text        not null references meganet.equipment_kind (key),
  make           text        not null default '',
  model          text        not null default '',
  serial_no      text        not null default '',
  note           text        not null default '',

  source         text        not null references meganet.equipment_source (key),
  photo_id       uuid        references meganet.field_photo (id) on delete set null,
  suggestion_id  uuid,

  created_at     timestamptz not null default now(),
  created_by     text        not null default '',
  updated_at     timestamptz not null default now(),
  updated_by     text,
  retired_at     timestamptz,
  retired_by     text,
  replaced_by    uuid        references meganet.station_equipment (id) on delete set null,

  constraint station_equipment_says_something check (make <> '' or model <> '' or serial_no <> ''),
  constraint station_equipment_lengths        check (pg_catalog.length(make) <= 100 and pg_catalog.length(model) <= 100
                                                     and pg_catalog.length(serial_no) <= 64 and pg_catalog.length(note) <= 1000),
  constraint station_equipment_retired_by     check ((retired_at is null) = (retired_by is null)),
  constraint station_equipment_replaced_live  check (replaced_by is null or retired_at is not null)
);

comment on table meganet.station_equipment is
  'A station''s equipment register: each unit fitted there, make, model and serial, how it was known, and — once replaced — when and by what. Live rows have no retired_at. Written only by meganet.decide_equipment_suggestion(); editors only, as the inspection records its serials came from are.';
comment on column meganet.station_equipment.serial_no is
  'As read or typed. Compared by meganet.equipment_serial_key() — letters and digits, upper-cased — so one live unit per serial, kind and station.';
comment on column meganet.station_equipment.replaced_by is
  'The unit that took this one''s place, when it was retired by an approval that replaced it.';

create unique index if not exists station_equipment_live_serial_idx
  on meganet.station_equipment (station_id, equipment_key, meganet.equipment_serial_key(serial_no))
  where retired_at is null and serial_no <> '';
create index if not exists station_equipment_live_idx on meganet.station_equipment (station_id, equipment_key) where retired_at is null;

drop trigger if exists station_equipment_touch on meganet.station_equipment;
create trigger station_equipment_touch before update on meganet.station_equipment
  for each row execute function meganet.touch_updated_at();

-- ── 4. What somebody, or something, thinks is fitted ──────────────────────────

create table if not exists meganet.equipment_suggestion (
  id              uuid        primary key default gen_random_uuid(),
  station_id      text        not null references meganet.station (id) on delete cascade,
  -- The photo it was read off. Null when an agent proposes from something
  -- else — an inspection's history, a delivery note.
  photo_id        uuid        references meganet.field_photo (id) on delete set null,

  equipment_key   text        not null references meganet.equipment_kind (key),
  make            text        not null default '',
  model           text        not null default '',
  serial_no       text        not null default '',

  -- Why: the text the OCR read that the candidate came from, or the agent's
  -- reason, in its own words. How sure, 0 to 1, as the proposer rates it.
  evidence        text        not null default '',
  confidence      numeric,

  -- What proposed it — 'ocr', 'agent:<name>', or a person's address — and who
  -- called the function to say so.
  proposed_by     text        not null,
  created_by      text        not null default '',
  created_at      timestamptz not null default now(),

  -- A state machine the two functions below walk, not a vocabulary that
  -- grows, which is why it is a check and not a table.
  status          text        not null default 'pending',
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  -- What the administrator corrected before approving, as sent.
  decision_patch  jsonb,
  -- The register row an approval wrote or confirmed.
  equipment_id    uuid,

  constraint equipment_suggestion_status        check (status in ('pending', 'approved', 'rejected', 'superseded')),
  constraint equipment_suggestion_decided       check ((status = 'pending') = (decided_at is null)
                                                       and (decided_at is null) = (decided_by is null)),
  constraint equipment_suggestion_confidence    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint equipment_suggestion_says_something check (make <> '' or model <> '' or serial_no <> ''),
  constraint equipment_suggestion_lengths       check (pg_catalog.length(make) <= 100 and pg_catalog.length(model) <= 100
                                                       and pg_catalog.length(serial_no) <= 64 and pg_catalog.length(evidence) <= 2000
                                                       and pg_catalog.length(proposed_by) between 1 and 200),
  constraint equipment_suggestion_patch_object  check (decision_patch is null or pg_catalog.jsonb_typeof(decision_patch) = 'object'),
  constraint equipment_suggestion_register_row  check (equipment_id is null or status = 'approved')
);

comment on table meganet.equipment_suggestion is
  'A proposed change to a station''s equipment register — read off a photo''s labels by the OCR, typed by a person, or proposed by an agent — and the administrator''s decision on it. Written only by meganet.propose_equipment() and meganet.decide_equipment_suggestion(); editors only.';
comment on column meganet.equipment_suggestion.status is
  'pending until an administrator approves or rejects it; superseded when another suggestion for the same unit was approved first.';

-- The same photo, kind and unit waiting twice is one suggestion. And for an
-- agent proposing without a photo, the same station, kind and unit.
create unique index if not exists equipment_suggestion_pending_photo_idx
  on meganet.equipment_suggestion (photo_id, equipment_key, meganet.equipment_identity(serial_no, model))
  where status = 'pending' and photo_id is not null;
create unique index if not exists equipment_suggestion_pending_bare_idx
  on meganet.equipment_suggestion (station_id, equipment_key, meganet.equipment_identity(serial_no, model))
  where status = 'pending' and photo_id is null;
create index if not exists equipment_suggestion_status_idx  on meganet.equipment_suggestion (status, created_at desc);
create index if not exists equipment_suggestion_station_idx on meganet.equipment_suggestion (station_id) where status = 'pending';
create index if not exists equipment_suggestion_photo_idx   on meganet.equipment_suggestion (photo_id) where photo_id is not null;

-- The two tables point at each other: an approved suggestion at the register
-- row it wrote, a register row at the suggestion it came from. Added once both
-- exist, and only if not already there, so a re-apply is a no-op.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'station_equipment_suggestion_fkey'
                    and conrelid = 'meganet.station_equipment'::regclass) then
    alter table meganet.station_equipment
      add constraint station_equipment_suggestion_fkey
      foreign key (suggestion_id) references meganet.equipment_suggestion (id) on delete set null;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'equipment_suggestion_equipment_fkey'
                    and conrelid = 'meganet.equipment_suggestion'::regclass) then
    alter table meganet.equipment_suggestion
      add constraint equipment_suggestion_equipment_fkey
      foreign key (equipment_id) references meganet.station_equipment (id) on delete set null;
  end if;
end
$$;

-- ── Proposing ─────────────────────────────────────────────────────────────────
-- The seam. Anything that thinks it knows what is fitted at a station says so
-- here, and it waits for an administrator. Editors and service_role.
--
--   { station_id, photo_id, equipment_key, make, model, serial_no,
--     evidence, confidence, proposed_by }
--
-- station_id may be left out when the photo is filed under a station — the
-- suggestion is for that one. At least one of make, model and serial_no.
--
-- proposed_by says what proposed it, and is checked against who is calling:
-- a signed-in editor proposes as themselves or as 'ocr' (the OCR the tab ran
-- at their press of a button); only the service key, or the owner at a psql
-- prompt, may propose as 'agent:<name>' or name another address. A proposal
-- nobody could trace is a proposal nobody can learn from.
--
-- Refused, each with the id of what it collides with as the detail, so a
-- caller in a loop (a scan of sixty photos) can count them rather than fail:
--   * the same unit, of the same kind, from the same photo, already pending;
--   * the same unit already live on the station's register — nothing to change;
--   * the same unit from the same photo proposed before and rejected — asking
--     again would ask the same administrator the same question.
create or replace function meganet.propose_equipment(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key      text;
  v_actor    text := meganet.actor();
  v_trusted  boolean;
  v_photo    meganet.field_photo%rowtype;
  v_photo_id uuid;
  v_station  text;
  v_kind     meganet.equipment_kind%rowtype;
  v_make     text;
  v_model    text;
  v_serial   text;
  v_evidence text;
  v_conf     numeric;
  v_by       text;
  v_ident    text;
  v_dup      meganet.equipment_suggestion%rowtype;
  v_live     meganet.station_equipment%rowtype;
  v_row      meganet.equipment_suggestion%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to propose equipment'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.propose_equipment() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('station_id', 'photo_id', 'equipment_key', 'make', 'model', 'serial_no',
                     'evidence', 'confidence', 'proposed_by') then
      raise exception 'meganet.propose_equipment() does not take %', v_key
        using errcode = '22023',
              hint    = 'station_id, photo_id, equipment_key, make, model, serial_no, evidence, confidence and proposed_by are the whole list';
    end if;
  end loop;

  -- The service key, or the owner at a prompt: no JWT on the request at all.
  v_trusted := v_actor = 'service_role'
               or (nullif(pg_catalog.current_setting('request.jwt.claims', true), '') is null
                   and coalesce(nullif(pg_catalog.current_setting('role', true), 'none'), current_user::text)
                       not in ('anon', 'authenticated', 'authenticator'));

  -- The photo, if it was read off one.
  begin
    v_photo_id := nullif(p ->> 'photo_id', '')::uuid;
  exception when others then
    raise exception 'photo_id has to be a uuid, not %', p ->> 'photo_id' using errcode = '22023';
  end;
  if v_photo_id is not null then
    select * into v_photo from meganet.field_photo where id = v_photo_id and deleted_at is null;
    if not found then
      raise exception 'no such field photo: %', v_photo_id using errcode = '23503';
    end if;
  end if;

  -- The station: the one sent, or the photo's.
  v_station := coalesce(nullif(p ->> 'station_id', ''), v_photo.station_id);
  if v_station is null then
    raise exception 'a suggestion has to say which station it is for — the photo is filed under none'
      using errcode = '22023',
            hint    = 'file the photo under its station first, or send station_id';
  end if;
  if not exists (select 1 from meganet.station where id = v_station and deleted_at is null) then
    raise exception 'no such station: %', v_station using errcode = '23503';
  end if;

  select * into v_kind from meganet.equipment_kind where key = p ->> 'equipment_key';
  if not found then
    raise exception '% is not a kind of equipment the register knows', coalesce(p ->> 'equipment_key', '(none)')
      using errcode = '23503',
            hint    = 'see meganet.equipment_kind — logger, modem, ert_a2, tbrg, solar_regulator and the rest';
  end if;

  v_make   := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'make', ''), '\s+', ' ', 'g'));
  v_model  := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'model', ''), '\s+', ' ', 'g'));
  v_serial := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'serial_no', ''), '\s+', ' ', 'g'));
  if v_make = '' and v_model = '' and v_serial = '' then
    raise exception 'a suggestion with no make, model or serial number says nothing about the %', pg_catalog.lower(v_kind.label)
      using errcode = '22023';
  end if;
  if pg_catalog.length(v_make) > 100 or pg_catalog.length(v_model) > 100 then
    raise exception 'a make or a model is at most 100 characters — that reads like a paragraph, not a label'
      using errcode = '22023';
  end if;
  if pg_catalog.length(v_serial) > 64 then
    raise exception 'a serial number is at most 64 characters' using errcode = '22023';
  end if;
  v_evidence := pg_catalog.left(coalesce(p ->> 'evidence', ''), 2000);

  begin
    v_conf := (p ->> 'confidence')::numeric;
  exception when others then
    raise exception 'confidence has to be a number from 0 to 1' using errcode = '22023';
  end;
  if v_conf is not null and (v_conf < 0 or v_conf > 1) then
    raise exception 'confidence has to be from 0 to 1, not %', v_conf using errcode = '22023';
  end if;

  -- Who says so.
  v_by := nullif(pg_catalog.btrim(coalesce(p ->> 'proposed_by', '')), '');
  if v_by is null then
    if v_actor = 'service_role' then
      raise exception 'the service key has to say what is proposing — ''agent:<name>'', ''ocr'' or an address'
        using errcode = '22023';
    end if;
    v_by := v_actor;
  elsif v_by = 'ocr' or v_by = v_actor then
    null;
  elsif v_by ~ '^agent:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' or v_by like '%@%' then
    if not v_trusted then
      raise exception 'only the service key may propose as %', v_by
        using errcode = '42501',
              hint    = 'a signed-in editor proposes as themselves, or as ''ocr'' for what the tab read';
    end if;
  else
    raise exception '% is not something that proposes — ''ocr'', ''agent:<name>'' or an address', v_by
      using errcode = '22023';
  end if;

  -- The three collisions.
  v_ident := meganet.equipment_identity(v_serial, v_model);
  select * into v_dup from meganet.equipment_suggestion s
   where s.status = 'pending' and s.equipment_key = v_kind.key
     and meganet.equipment_identity(s.serial_no, s.model) = v_ident
     and (case when v_photo_id is null then s.photo_id is null and s.station_id = v_station
               else s.photo_id = v_photo_id end)
   limit 1;
  if found then
    raise exception 'the same % is already waiting for a decision%', pg_catalog.lower(v_kind.label),
      case when v_photo_id is null then '' else ' from this photo' end
      using errcode = '23505', detail = v_dup.id::text;
  end if;

  if v_serial <> '' then
    select * into v_live from meganet.station_equipment e
     where e.station_id = v_station and e.equipment_key = v_kind.key and e.retired_at is null
       and meganet.equipment_serial_key(e.serial_no) = meganet.equipment_serial_key(v_serial)
     limit 1;
    if found then
      raise exception 'that % (serial %) is already on the station''s register', pg_catalog.lower(v_kind.label), v_live.serial_no
        using errcode = '23505', detail = v_live.id::text;
    end if;
  end if;

  if v_photo_id is not null then
    select * into v_dup from meganet.equipment_suggestion s
     where s.status = 'rejected' and s.photo_id = v_photo_id and s.equipment_key = v_kind.key
       and meganet.equipment_identity(s.serial_no, s.model) = v_ident
     order by s.decided_at desc
     limit 1;
    if found then
      raise exception 'that was proposed from this photo before, and % turned it down on %',
        coalesce(v_dup.decided_by, 'an administrator'), pg_catalog.to_char(v_dup.decided_at, 'YYYY-MM-DD')
        using errcode = '23505', detail = v_dup.id::text;
    end if;
  end if;

  insert into meganet.equipment_suggestion (
      station_id, photo_id, equipment_key, make, model, serial_no,
      evidence, confidence, proposed_by, created_by)
  values (
      v_station, v_photo_id, v_kind.key, v_make, v_model, v_serial,
      v_evidence, v_conf, pg_catalog.left(v_by, 200), v_actor)
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.propose_equipment(jsonb) is
  'Propose a change to a station''s equipment register, to wait for an administrator. Editors (as themselves, or as ''ocr'') and service_role (as ''agent:<name>'' — the seam an agent uses). Refuses, with the colliding id as the detail, a unit already pending from the same photo, already live on the register, or rejected before from the same photo.';

-- ── Deciding ──────────────────────────────────────────────────────────────────
-- Administrators only. Reject marks the suggestion and changes nothing else.
-- Approve writes the register and marks the suggestion, in one transaction.
--
-- p_patch is what the administrator corrected first — equipment_key, make,
-- model, serial_no, note — and `replaces` (below). What was proposed stays on
-- the suggestion; the patch is kept beside it; the register gets the result.
--
-- Where the approved unit goes, in this order — the first that applies:
--
--   1. `replaces` in the patch says so outright: the id of a live unit at the
--      station to retire in favour of this one, or null to add this one
--      alongside whatever is there.
--   2. The same unit is already live — same kind, same serial (letters and
--      digits) — and is updated: the photo is fresher evidence of it, and a
--      make or model it lacked is filled in.
--   3. A live unit of the kind whose serial was never known, of the same model
--      (or of no recorded model), is taken to be this one: it gets the serial.
--      With no serial proposed, a live unit of the same model is this one.
--   4. One live unit of the kind, some other unit: this one replaced it. It is
--      retired, pointing at the new one.
--   5. Several live units of the kind and nothing above to choose between
--      them: refused, asking which — a guess here would retire the wrong radio.
--   6. None of the kind: added.
--
-- Then every other pending suggestion for the same unit at the station is
-- marked superseded, so the queue does not ask about it again.
create or replace function meganet.decide_equipment_suggestion(
         p_id uuid, p_decision text, p_note text default null, p_patch jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     text := meganet.actor();
  v_decision  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_decision, '')));
  v_note      text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_patch     jsonb := case when p_patch is null or p_patch = '{}'::jsonb then null else p_patch end;
  v_s         meganet.equipment_suggestion%rowtype;
  v_kind      meganet.equipment_kind%rowtype;
  v_key       text;
  v_make      text;
  v_model     text;
  v_serial    text;
  v_enote     text;
  v_source    text;
  v_replace   uuid;
  v_explicit  boolean := false;
  v_unit      meganet.station_equipment%rowtype;
  v_found     boolean := false;
  v_old       meganet.station_equipment%rowtype;
  v_n         integer;
  v_new       meganet.station_equipment%rowtype;
  v_retired   uuid[] := '{}';
  v_super     integer := 0;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator may approve or reject equipment suggestions'
      using errcode = '42501',
            hint    = 'an administrator is an editor whose meganet.app_user row says role = ''admin'' — the owner grants it; see docs/field-photos.md';
  end if;
  if v_decision not in ('approve', 'reject') then
    raise exception 'a decision is approve or reject, not %', coalesce(nullif(p_decision, ''), 'nothing') using errcode = '22023';
  end if;

  select * into v_s from meganet.equipment_suggestion where id = p_id for update;
  if not found then
    raise exception 'no such equipment suggestion: %', p_id using errcode = 'P0002';
  end if;
  if v_s.status <> 'pending' then
    raise exception 'that suggestion was already % by % on %', v_s.status, coalesce(v_s.decided_by, 'somebody'),
      pg_catalog.to_char(v_s.decided_at, 'YYYY-MM-DD')
      using errcode = '55000';
  end if;
  if pg_catalog.length(coalesce(v_note, '')) > 1000 then
    raise exception 'a decision''s note is at most 1,000 characters' using errcode = '22023';
  end if;

  if v_decision = 'reject' then
    if v_patch is not null then
      raise exception 'a rejection changes nothing, so it takes no corrections' using errcode = '22023';
    end if;
    update meganet.equipment_suggestion
       set status = 'rejected', decided_by = v_actor, decided_at = pg_catalog.now(), decision_note = v_note
     where id = p_id
    returning * into v_s;
    return pg_catalog.jsonb_build_object('suggestion', pg_catalog.to_jsonb(v_s));
  end if;

  -- Approving. The corrections first.
  if v_patch is not null and pg_catalog.jsonb_typeof(v_patch) <> 'object' then
    raise exception 'the corrections are a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(coalesce(v_patch, '{}'::jsonb)) loop
    if v_key not in ('equipment_key', 'make', 'model', 'serial_no', 'note', 'replaces') then
      raise exception 'an approval does not correct %', v_key
        using errcode = '22023',
              hint    = 'equipment_key, make, model, serial_no, note and replaces are the whole list';
    end if;
  end loop;

  v_key    := coalesce(nullif(v_patch ->> 'equipment_key', ''), v_s.equipment_key);
  v_make   := case when v_patch ? 'make'      then pg_catalog.btrim(coalesce(v_patch ->> 'make', ''))      else v_s.make end;
  v_model  := case when v_patch ? 'model'     then pg_catalog.btrim(coalesce(v_patch ->> 'model', ''))     else v_s.model end;
  v_serial := case when v_patch ? 'serial_no' then pg_catalog.btrim(coalesce(v_patch ->> 'serial_no', '')) else v_s.serial_no end;
  v_enote  := pg_catalog.btrim(coalesce(v_patch ->> 'note', ''));

  select * into v_kind from meganet.equipment_kind where key = v_key;
  if not found then
    raise exception '% is not a kind of equipment the register knows', v_key using errcode = '23503';
  end if;
  if v_make = '' and v_model = '' and v_serial = '' then
    raise exception 'with those corrections the suggestion says nothing — no make, model or serial is left'
      using errcode = '22023';
  end if;
  if pg_catalog.length(v_make) > 100 or pg_catalog.length(v_model) > 100 or pg_catalog.length(v_serial) > 64
     or pg_catalog.length(v_enote) > 1000 then
    raise exception 'a make or model is at most 100 characters, a serial 64 and a note 1,000' using errcode = '22023';
  end if;
  if not exists (select 1 from meganet.station where id = v_s.station_id and deleted_at is null) then
    raise exception 'the station this suggestion is for has been deleted' using errcode = '23503';
  end if;

  v_source := case when v_s.proposed_by = 'ocr' then 'photo'
                   when v_s.proposed_by like 'agent:%' then 'agent'
                   else 'manual' end;

  -- 1. Said outright.
  if v_patch ? 'replaces' then
    v_explicit := true;
    begin
      v_replace := nullif(v_patch ->> 'replaces', '')::uuid;
    exception when others then
      raise exception 'replaces is the id of a unit on the register, or null' using errcode = '22023';
    end;
    if v_replace is not null then
      select * into v_old from meganet.station_equipment
       where id = v_replace and station_id = v_s.station_id and retired_at is null
       for update;
      if not found then
        raise exception 'there is no live unit % at this station to replace', v_replace using errcode = '23503';
      end if;
    end if;
    -- Said outright is not a way round the register's one rule: a serial is
    -- live once per kind and station.
    if meganet.equipment_serial_key(v_serial) <> '' then
      select * into v_unit from meganet.station_equipment e
       where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
         and e.id is distinct from v_replace
         and meganet.equipment_serial_key(e.serial_no) = meganet.equipment_serial_key(v_serial);
      if found then
        raise exception 'serial % is already live on this station''s register as another % — approve without replaces to confirm that one',
          v_unit.serial_no, pg_catalog.lower(v_kind.label)
          using errcode = '23505', detail = v_unit.id::text;
      end if;
    end if;
  end if;

  if not v_explicit then
    -- 2. The same unit.
    if meganet.equipment_serial_key(v_serial) <> '' then
      select * into v_unit from meganet.station_equipment e
       where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
         and meganet.equipment_serial_key(e.serial_no) = meganet.equipment_serial_key(v_serial)
       for update;
      v_found := found;
    end if;

    -- 3. The unit whose serial was never known, of the same model or with no
    -- model on one side to disagree; or, with no serial proposed, the unit of
    -- the same model.
    if not v_found then
      select count(*) into v_n from meganet.station_equipment e
       where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
         and (case when meganet.equipment_serial_key(v_serial) <> ''
                   then meganet.equipment_serial_key(e.serial_no) = ''
                        and (e.model = '' or v_model = ''
                             or meganet.equipment_serial_key(e.model) = meganet.equipment_serial_key(v_model))
                   else v_model <> '' and meganet.equipment_serial_key(e.model) = meganet.equipment_serial_key(v_model) end);
      if v_n = 1 then
        select * into v_unit from meganet.station_equipment e
         where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
           and (case when meganet.equipment_serial_key(v_serial) <> ''
                     then meganet.equipment_serial_key(e.serial_no) = ''
                          and (e.model = '' or v_model = ''
                               or meganet.equipment_serial_key(e.model) = meganet.equipment_serial_key(v_model))
                     else v_model <> '' and meganet.equipment_serial_key(e.model) = meganet.equipment_serial_key(v_model) end)
         for update;
        v_found := true;
      elsif v_n > 1 then
        raise exception 'there are % live % units at this station that could be this one — say which it replaces, or that it is added alongside',
          v_n, pg_catalog.lower(v_kind.label)
          using errcode = '22023',
                hint    = 'approve with replaces: the id of the unit, or replaces: null to add it alongside';
      end if;
    end if;

    -- 4 and 5. Some other unit of the kind.
    if not v_found then
      select count(*) into v_n from meganet.station_equipment e
       where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null;
      if v_n = 1 then
        select * into v_old from meganet.station_equipment e
         where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
         for update;
      elsif v_n > 1 then
        raise exception 'there are % live % units at this station — say which one this replaces, or that it is added alongside',
          v_n, pg_catalog.lower(v_kind.label)
          using errcode = '22023',
                hint    = 'approve with replaces: the id of the unit, or replaces: null to add it alongside';
      end if;
    end if;
  end if;

  if v_found then
    -- The same unit, seen again: fresher evidence, and what it lacked.
    update meganet.station_equipment e
       set make          = case when v_make <> ''   then v_make   else e.make end,
           model         = case when v_model <> ''  then v_model  else e.model end,
           serial_no     = case when v_serial <> '' then v_serial else e.serial_no end,
           note          = case when v_enote <> ''  then v_enote  else e.note end,
           photo_id      = coalesce(v_s.photo_id, e.photo_id),
           suggestion_id = v_s.id,
           updated_by    = v_actor
     where e.id = v_unit.id
    returning * into v_new;
  else
    -- A unit the register did not have. What it replaced is retired first —
    -- so a unit re-registered under a corrected serial never meets itself in
    -- the unique index — then this one added, then the old one pointed at it.
    if v_old.id is not null then
      update meganet.station_equipment
         set retired_at = pg_catalog.now(), retired_by = v_actor, updated_by = v_actor
       where id = v_old.id;
    end if;
    insert into meganet.station_equipment (
        station_id, equipment_key, make, model, serial_no, note, source, photo_id, suggestion_id, created_by, updated_by)
    values (
        v_s.station_id, v_key, v_make, v_model, v_serial, v_enote, v_source, v_s.photo_id, v_s.id, v_actor, v_actor)
    returning * into v_new;
    if v_old.id is not null then
      update meganet.station_equipment set replaced_by = v_new.id where id = v_old.id;
      v_retired := array[v_old.id];
    end if;
  end if;

  update meganet.equipment_suggestion
     set status = 'approved', decided_by = v_actor, decided_at = pg_catalog.now(),
         decision_note = v_note, decision_patch = v_patch, equipment_id = v_new.id
   where id = p_id
  returning * into v_s;

  -- Every other pending suggestion for the unit now on the register.
  update meganet.equipment_suggestion s
     set status = 'superseded', decided_by = v_actor, decided_at = pg_catalog.now(),
         decision_note = pg_catalog.format('the same unit was approved from suggestion %s', v_s.id)
   where s.status = 'pending' and s.id <> v_s.id
     and s.station_id = v_new.station_id and s.equipment_key = v_new.equipment_key
     and (case when meganet.equipment_serial_key(v_new.serial_no) <> ''
               then meganet.equipment_serial_key(s.serial_no) = meganet.equipment_serial_key(v_new.serial_no)
               else meganet.equipment_serial_key(s.serial_no) = ''
                    and meganet.equipment_serial_key(s.model) = meganet.equipment_serial_key(v_new.model) end);
  get diagnostics v_super = row_count;

  return pg_catalog.jsonb_build_object(
    'suggestion', pg_catalog.to_jsonb(v_s),
    'equipment',  pg_catalog.to_jsonb(v_new),
    'retired',    pg_catalog.to_jsonb(v_retired),
    'superseded', v_super);
end;
$$;

comment on function meganet.decide_equipment_suggestion(uuid, text, text, jsonb) is
  'Approve or reject an equipment suggestion. Administrators only (meganet.is_admin()). Approve takes corrections (equipment_key, make, model, serial_no, note, replaces), writes the station''s register — updating the same unit, retiring the one it replaced — and supersedes the other pending suggestions for that unit.';

-- ── Row level security ────────────────────────────────────────────────────────
-- Six tables, RLS in the same file (db/README.md). The two vocabularies are
-- public; the log, the register and the suggestions are editors only. None has
-- a policy for any write: the functions above write, and service_role.

alter table meganet.field_photo_outcome  enable row level security;
alter table meganet.field_photo_upload   enable row level security;
alter table meganet.equipment_source     enable row level security;
alter table meganet.station_equipment    enable row level security;
alter table meganet.equipment_suggestion enable row level security;

drop policy if exists field_photo_outcome_read_all on meganet.field_photo_outcome;
create policy field_photo_outcome_read_all on meganet.field_photo_outcome for select using (true);
drop policy if exists equipment_source_read_all on meganet.equipment_source;
create policy equipment_source_read_all on meganet.equipment_source for select using (true);

drop policy if exists field_photo_upload_read_editors on meganet.field_photo_upload;
create policy field_photo_upload_read_editors on meganet.field_photo_upload
  for select to authenticated
  using (meganet.is_editor());

drop policy if exists station_equipment_read_editors on meganet.station_equipment;
create policy station_equipment_read_editors on meganet.station_equipment
  for select to authenticated
  using (meganet.is_editor());

drop policy if exists equipment_suggestion_read_editors on meganet.equipment_suggestion;
create policy equipment_suggestion_read_editors on meganet.equipment_suggestion
  for select to authenticated
  using (meganet.is_editor());

-- ── Who may run what ──────────────────────────────────────────────────────────
-- Every function has EXECUTE revoked from public and granted back by name —
-- the two pure ones too, so the list of what anon can call stays a list
-- somebody wrote. is_admin() goes to the same three roles as is_editor(): it
-- answers a question about the caller and nothing else.

revoke all on function meganet.log_field_photo_upload(jsonb)                          from public;
revoke all on function meganet.prune_field_photo_uploads(interval)                    from public;
revoke all on function meganet.is_admin()                                             from public;
revoke all on function meganet.equipment_serial_key(text)                             from public;
revoke all on function meganet.equipment_identity(text, text)                         from public;
revoke all on function meganet.propose_equipment(jsonb)                               from public;
revoke all on function meganet.decide_equipment_suggestion(uuid, text, text, jsonb)   from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Said out loud, and re-said on every run, for 0010's reason.
  revoke insert, update, delete, truncate on
      meganet.field_photo_upload, meganet.station_equipment, meganet.equipment_suggestion
    from anon, authenticated;
  revoke all on meganet.field_photo_upload, meganet.station_equipment, meganet.equipment_suggestion from anon;

  grant select on meganet.field_photo_outcome, meganet.equipment_source to anon, authenticated;
  grant select on meganet.field_photo_upload, meganet.station_equipment, meganet.equipment_suggestion to authenticated;

  grant select, insert, update, delete on
      meganet.field_photo_outcome, meganet.equipment_source,
      meganet.field_photo_upload, meganet.station_equipment, meganet.equipment_suggestion
    to service_role;

  grant execute on function meganet.log_field_photo_upload(jsonb)                        to authenticated, service_role;
  grant execute on function meganet.prune_field_photo_uploads(interval)                  to service_role;
  grant execute on function meganet.is_admin()                                           to anon, authenticated, service_role;
  -- The index expressions and the functions above call these as their owner;
  -- the signed-in roles get them so that a query somebody writes against the
  -- register compares serials the way the register does.
  grant execute on function meganet.equipment_serial_key(text)                           to authenticated, service_role;
  grant execute on function meganet.equipment_identity(text, text)                       to authenticated, service_role;
  grant execute on function meganet.propose_equipment(jsonb)                             to authenticated, service_role;
  grant execute on function meganet.decide_equipment_suggestion(uuid, text, text, jsonb) to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 35 → 36 in the same commit as this file.
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '36')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
