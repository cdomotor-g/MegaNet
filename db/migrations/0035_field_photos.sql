-- 0035_field_photos.sql — Field photos: pictures of the ground the network
-- stands on, filed by where they were taken rather than by which form they
-- were attached to.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0035_field_photos.sql
--
-- Then, once per project, the bucket the rows index into — which is not ours
-- to migrate, for 0010's reason:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/storage_bucket.sql
--
-- ── Why not meganet.attachment ────────────────────────────────────────────────
--
-- 0009 and 0010 already hold photos — an inspection's, a maintenance visit's —
-- and the obvious move was one more owner column on that table. It is the wrong
-- one, for three reasons that are facts about the pictures rather than about
-- taste:
--
--   · An attachment's identity is its owner. `attachment_belongs_to_exactly_one`
--     says so, the object path is filed under the owner's id, and an attachment
--     with no form to hang off cannot exist. A field photo's identity is *where
--     it was taken*: most of them are not part of any visit anybody wrote up,
--     and the ones that are were still taken somewhere, which is the question
--     the twin asks.
--   · A photo that arrives from Dropbox has no owner at all when it arrives,
--     and may have no position either. Both are states this table has to hold
--     and that one refuses by construction.
--   · The same bytes must not become two photos. Somebody drags last week's
--     folder in again; the sync is re-run from scratch. So this table is keyed,
--     as well as by path, by the SHA-256 of the file as it arrived — and a
--     photo removed here stays removed from the sync by its Dropbox file id.
--     Neither rule belongs on a form's attachments.
--
-- What the two do share is the vocabulary of what may be uploaded
-- (meganet.attachment_type, 0010): the same types and the same limits, so a
-- new camera format is still one insert for both. And the same shape of door:
-- three functions rather than a grant, for 0010's three reasons — the object
-- path has to agree with the row, the object's name has to be one the app
-- generated (the bucket is private and a signed URL is only as private as its
-- path is unguessable), and `uploaded_by` has to be the caller.
--
-- ── Who may see them ──────────────────────────────────────────────────────────
--
-- Editors, and nobody holding only the anon key: the rows, the positions and
-- the bytes alike. A field photo shows a site's access track, its padlock, a
-- landowner's shed and, as often as not, a colleague — the same reason the
-- inspection records are editors-only (0009) — and a photo's coordinates are
-- as much a disclosure as its pixels. The twin and the map draw them for a
-- signed-in session and say "sign in" otherwise.
--
-- ── Soft delete, and why here when attachments are not ────────────────────────
--
-- remove_field_photo() stamps deleted_at and hands back the object paths for
-- the caller to delete — the bytes go; the row stays as a tombstone. The
-- tombstone is what keeps a photo somebody removed from coming straight back
-- on the next Dropbox sync (the sync matches on origin_ref, deleted rows
-- included), and it is invisible to everyone but service_role: the read policy
-- below filters it out. A photo dropped in by hand again after being removed is
-- allowed back — the SHA-256 is unique among live rows only — because a person
-- doing that means it.

-- ── Two small vocabularies ────────────────────────────────────────────────────
-- Tables rather than check constraints, so the next way in (a phone app's own
-- upload, say) or the next way of placing a photo is an insert.

create table if not exists meganet.field_photo_origin (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.field_photo_origin is
  'How a field photo reached MegaNet. Public: it describes the doors, not any photo.';

insert into meganet.field_photo_origin (key, ord, label) values
  ('upload',  1, 'Uploaded on the Field Photos tab'),
  ('dropbox', 2, 'Imported from Dropbox by the sync')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.field_photo_placement (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.field_photo_placement is
  'Where a field photo''s position came from, most trustworthy first. Public, like the other vocabularies.';

insert into meganet.field_photo_placement (key, ord, label) values
  ('exif',    1, 'The camera''s GPS (EXIF)'),
  ('xmp',     2, 'The camera''s GPS (XMP)'),
  ('ocr',     3, 'Read off the picture''s overlay'),
  ('manual',  4, 'Placed by hand'),
  ('station', 5, 'At a station''s recorded position')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- ── The photos ────────────────────────────────────────────────────────────────

create table if not exists meganet.field_photo (
  id              uuid        primary key default gen_random_uuid(),

  storage_bucket  text        not null default 'field-photos',
  storage_path    text        not null,
  thumb_path      text,
  content_type    text        not null references meganet.attachment_type (content_type),
  byte_size       bigint      not null,
  sha256          text        not null,
  width           integer,
  height          integer,

  title           text        not null default '',
  caption         text        not null default '',

  -- When: the instant, and the camera's own clock as it was written, because
  -- a zone that had to be assumed can be wrong and the local reading cannot.
  taken_at        timestamptz,
  taken_local     text,
  taken_source    text,

  -- Where, and what it was looking at.
  lat             numeric,
  lon             numeric,
  placement       text        references meganet.field_photo_placement (key),
  accuracy_m      numeric,
  altitude_m      numeric,
  altitude_ref    text,
  heading_deg     numeric,
  heading_ref     text,
  pitch_deg       numeric,
  fov_deg         numeric,

  -- The station it is of: the nearest within a kilometre unless somebody said
  -- otherwise, and which of the two it was.
  station_id      text        references meganet.station (id) on delete set null,
  station_auto    boolean     not null default false,

  meta            jsonb       not null default '{}'::jsonb,

  origin          text        not null default 'upload' references meganet.field_photo_origin (key),
  origin_ref      text,

  uploaded_by     text        not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text,
  deleted_at      timestamptz,
  deleted_by      text,

  constraint field_photo_bucket        check (storage_bucket = 'field-photos'),
  constraint field_photo_is_image      check (content_type like 'image/%'),
  constraint field_photo_has_bytes     check (byte_size > 0),
  constraint field_photo_sha256        check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint field_photo_size          check ((width is null or width > 0) and (height is null or height > 0)),
  constraint field_photo_both_or_none  check ((lat is null) = (lon is null)),
  constraint field_photo_on_the_earth  check (lat between -90 and 90 and lon between -180 and 180),
  constraint field_photo_placed_how    check ((lat is null) = (placement is null)),
  constraint field_photo_accuracy      check (accuracy_m is null or accuracy_m >= 0),
  constraint field_photo_altitude_ref  check (altitude_ref is null or altitude_ref in ('HAE', 'MSL', 'AHD')),
  constraint field_photo_heading       check (heading_deg is null or (heading_deg >= 0 and heading_deg < 360)),
  constraint field_photo_heading_ref   check (heading_ref is null or heading_ref in ('T', 'M')),
  constraint field_photo_pitch         check (pitch_deg is null or pitch_deg between -90 and 90),
  constraint field_photo_fov           check (fov_deg is null or (fov_deg > 0 and fov_deg <= 180)),
  constraint field_photo_taken_source  check (taken_source is null or taken_source in ('exif', 'xmp', 'ocr', 'manual')),
  constraint field_photo_meta_object   check (jsonb_typeof(meta) = 'object'),
  constraint field_photo_deleted_by    check ((deleted_at is null) = (deleted_by is null))
);

comment on table meganet.field_photo is
  'A field photo: the bytes in the private field-photos bucket, and here where and when it was taken, what it was looking at, and how each of those was known. Editors only. Soft-deleted rows are tombstones that keep a removed Dropbox photo from being re-imported.';
comment on column meganet.field_photo.sha256 is
  'Of the file as it arrived (before any HEIC-to-JPEG conversion). Unique among live photos: the same bytes twice is one photo.';
comment on column meganet.field_photo.taken_local is
  'The camera''s own clock, as written (YYYY-MM-DDTHH:MM:SS, no zone). taken_at is this plus a zone, which meta.taken.zone_source says how it was known — the camera, its GPS clock, or assumed from where it was taken.';
comment on column meganet.field_photo.altitude_m is
  'As the source gave it, in altitude_ref: EXIF is above sea level, Solocator prints height above the ellipsoid (HAE, ~40 m off AHD in Queensland). Never used to stand a marker — the ground under it is.';
comment on column meganet.field_photo.heading_deg is
  'Which way the camera was pointing, degrees clockwise from north, as heading_ref says (T true, M magnetic).';
comment on column meganet.field_photo.station_auto is
  'true when station_id was picked by distance (the nearest live station within 1 km) rather than by a person. A photo moved by hand is re-matched only while this is true.';
comment on column meganet.field_photo.meta is
  'What the file and the OCR said, kept for the record: the camera, the OCR''s readings and confidence, the original content type of a converted HEIC. Never read to decide anything.';
comment on column meganet.field_photo.origin_ref is
  'The origin''s own id for the file — Dropbox''s file id. Unique per origin, deleted rows included, which is what stops a removed photo being imported again.';

create unique index if not exists field_photo_object_idx on meganet.field_photo (storage_bucket, storage_path);
create unique index if not exists field_photo_sha256_live_idx on meganet.field_photo (sha256) where deleted_at is null;
create unique index if not exists field_photo_origin_ref_idx on meganet.field_photo (origin, origin_ref) where origin_ref is not null;
create index if not exists field_photo_where_idx on meganet.field_photo (lat, lon) where deleted_at is null and lat is not null;
create index if not exists field_photo_station_idx on meganet.field_photo (station_id) where deleted_at is null;
create index if not exists field_photo_taken_idx on meganet.field_photo (taken_at desc nulls last) where deleted_at is null;
create index if not exists field_photo_unplaced_idx on meganet.field_photo (created_at desc) where deleted_at is null and lat is null;

drop trigger if exists field_photo_touch on meganet.field_photo;
create trigger field_photo_touch before update on meganet.field_photo
  for each row execute function meganet.touch_updated_at();

-- ── What the Dropbox sync last did ────────────────────────────────────────────
-- One row per source, written by the sync (service_role) at the end of every
-- run, read by the Field Photos tab so "is it working?" has an answer on the
-- screen rather than in a workflow log. The cursor Dropbox hands back is kept
-- apart, in a table no browser role is granted at all — it is not a secret,
-- but it is nobody's business but the sync's.

create table if not exists meganet.field_photo_sync (
  source        text        primary key references meganet.field_photo_origin (key),
  folder        text        not null default '',
  account       text,
  last_run_at   timestamptz,
  last_ok_at    timestamptz,
  last_error    text,
  runs          integer     not null default 0,
  seen          integer     not null default 0,
  imported      integer     not null default 0,
  unplaced      integer     not null default 0,
  skipped       integer     not null default 0,
  failed        integer     not null default 0,
  detail        jsonb       not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

comment on table meganet.field_photo_sync is
  'What the last run of each photo sync did: when, how many files it saw, imported, could not place, skipped and failed, and the error if it stopped. Written by tools/field-photos/sync.mjs; read by the Field Photos tab. Editors only.';

create table if not exists meganet.field_photo_sync_cursor (
  source      text        primary key references meganet.field_photo_origin (key),
  cursor      text,
  updated_at  timestamptz not null default now()
);

comment on table meganet.field_photo_sync_cursor is
  'Where each sync got to — Dropbox''s list_folder cursor. RLS on, no policy and no grant to anon or authenticated: service_role only.';

drop trigger if exists field_photo_sync_touch on meganet.field_photo_sync;
create trigger field_photo_sync_touch before update on meganet.field_photo_sync
  for each row execute function meganet.touch_updated_at();
drop trigger if exists field_photo_sync_cursor_touch on meganet.field_photo_sync_cursor;
create trigger field_photo_sync_cursor_touch before update on meganet.field_photo_sync_cursor
  for each row execute function meganet.touch_updated_at();

-- ── The station a photo is of ─────────────────────────────────────────────────
-- The nearest live station with a position, within `p_within_m` (a kilometre
-- by default), or null. Equirectangular about the photo — exact to centimetres
-- at a kilometre — and boxed first so the order by never sees the other 3,000.
-- The browser works out the same suggestion from the station list it already
-- holds, before anything is uploaded; this is the rule when nobody sent one,
-- which is every photo the Dropbox sync imports.

create or replace function meganet.field_photo_station_for(
         p_lat numeric, p_lon numeric, p_within_m numeric default 1000)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with here as (
    select p_lat::float8 as lat, p_lon::float8 as lon,
           p_within_m::float8 as r,
           111320.0 * pg_catalog.cos(pg_catalog.radians(p_lat::float8)) as mx,
           110574.0 as my
  )
  select s.id
    from meganet.station s, here h
   where p_lat is not null and p_lon is not null
     and s.deleted_at is null and s.lat is not null and s.lon is not null
     and s.lat::float8 between h.lat - h.r / h.my and h.lat + h.r / h.my
     and s.lon::float8 between h.lon - h.r / h.mx and h.lon + h.r / h.mx
     and ((s.lon::float8 - h.lon) * h.mx) ^ 2 + ((s.lat::float8 - h.lat) * h.my) ^ 2 <= h.r ^ 2
   order by ((s.lon::float8 - h.lon) * h.mx) ^ 2 + ((s.lat::float8 - h.lat) * h.my) ^ 2, s.id
   limit 1
$$;

comment on function meganet.field_photo_station_for(numeric, numeric, numeric) is
  'The nearest live station with a position within p_within_m metres (default 1 km) of a point, or null.';

-- ── The three doors ───────────────────────────────────────────────────────────

-- Index one photo whose bytes are already in the bucket — bytes first, row
-- second, and the caller deletes the bytes again if this refuses, for 0010's
-- reason: an object nothing points at is a cheaper wrong state than a row
-- pointing at nothing.
--
-- A JSON object rather than twenty-seven arguments, with a closed key list: a
-- key this function does not know is a mistake worth hearing about, not a
-- field to drop on the floor.
create or replace function meganet.add_field_photo(p_photo jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type     meganet.attachment_type%rowtype;
  v_key      text;
  v_path     text;
  v_thumb    text;
  v_leaf     text;
  v_uuid     text;
  v_ext      text;
  v_lat      numeric;
  v_lon      numeric;
  v_place    text;
  v_station  text;
  v_auto     boolean := false;
  v_origin   text;
  v_ref      text;
  v_by       text;
  v_taken    timestamptz;
  v_dup      meganet.field_photo%rowtype;
  v_row      meganet.field_photo%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to add field photos'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  if p_photo is null or pg_catalog.jsonb_typeof(p_photo) <> 'object' then
    raise exception 'meganet.add_field_photo() needs a JSON object' using errcode = '22023';
  end if;

  for v_key in select pg_catalog.jsonb_object_keys(p_photo) loop
    if v_key not in ('storage_path', 'thumb_path', 'content_type', 'byte_size', 'sha256',
                     'width', 'height', 'title', 'caption', 'taken_at', 'taken_local', 'taken_source',
                     'lat', 'lon', 'placement', 'accuracy_m', 'altitude_m', 'altitude_ref',
                     'heading_deg', 'heading_ref', 'pitch_deg', 'fov_deg', 'station_id',
                     'meta', 'origin', 'origin_ref', 'uploaded_by') then
      raise exception 'meganet.add_field_photo() does not take %', v_key using errcode = '22023';
    end if;
  end loop;

  -- What it is, and whether it may be.
  select * into v_type from meganet.attachment_type where content_type = p_photo ->> 'content_type';
  if not found or v_type.content_type not like 'image/%' then
    raise exception '% is not a kind of picture this app accepts', coalesce(p_photo ->> 'content_type', '(none)')
      using errcode = '22023',
            hint    = 'see meganet.attachment_type — adding one is an insert, not a migration';
  end if;
  if (p_photo ->> 'byte_size') is null or (p_photo ->> 'byte_size')::bigint <= 0 then
    raise exception 'a photo needs its size in bytes' using errcode = '22023';
  end if;
  if (p_photo ->> 'byte_size')::bigint > v_type.max_bytes then
    raise exception '% is %.1f MB and the limit for % is %.1f MB',
      coalesce(nullif(p_photo ->> 'title', ''), p_photo ->> 'storage_path'),
      (p_photo ->> 'byte_size')::bigint / 1048576.0, v_type.label, v_type.max_bytes / 1048576.0
      using errcode = '22023';
  end if;
  if coalesce(p_photo ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'a photo needs the SHA-256 of its bytes, as 64 lower-case hex digits' using errcode = '22023';
  end if;

  -- Where it is. `photo/<uuid>.<ext>`, the uuid the app's own and the file's
  -- name kept in title; the thumbnail beside it under the same uuid.
  v_path := p_photo ->> 'storage_path';
  if v_path is null or pg_catalog.left(v_path, 6) <> 'photo/' then
    raise exception 'a field photo''s object path has to start with photo/' using errcode = '22023';
  end if;
  v_leaf := pg_catalog.substr(v_path, 7);
  if v_leaf !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$' then
    raise exception 'the object name has to be a generated uuid and an extension, not %', v_leaf
      using errcode = '22023',
            hint    = 'the app names the object; the file''s own name goes in title';
  end if;
  v_uuid := pg_catalog.split_part(v_leaf, '.', 1);
  v_ext  := pg_catalog.split_part(v_leaf, '.', 2);
  if not (v_ext = any (v_type.extensions)) then
    raise exception '% is not an extension % arrives under (%)',
      v_ext, v_type.label, pg_catalog.array_to_string(v_type.extensions, ', ')
      using errcode = '22023';
  end if;
  v_thumb := nullif(p_photo ->> 'thumb_path', '');
  if v_thumb is not null and v_thumb <> 'photo/' || v_uuid || '.thumb.jpg' then
    raise exception 'the thumbnail has to be photo/%.thumb.jpg, beside its photo', v_uuid using errcode = '22023';
  end if;

  -- The same bytes twice is one photo. Said with the id of the one already
  -- here, so the tab can offer to show it rather than only refuse.
  select * into v_dup from meganet.field_photo
   where sha256 = p_photo ->> 'sha256' and deleted_at is null
   limit 1;
  if found then
    raise exception 'this photo is already in MegaNet'
      using errcode = '23505',
            detail  = v_dup.id::text,
            hint    = pg_catalog.format('added by %s on %s', coalesce(nullif(v_dup.uploaded_by, ''), 'someone'),
                                        pg_catalog.to_char(v_dup.created_at, 'YYYY-MM-DD'));
  end if;

  -- The door it came in by.
  v_origin := coalesce(nullif(p_photo ->> 'origin', ''), 'upload');
  if not exists (select 1 from meganet.field_photo_origin where key = v_origin) then
    raise exception '% is not a way in for a field photo', v_origin using errcode = '23503';
  end if;
  v_ref := nullif(p_photo ->> 'origin_ref', '');
  if v_ref is not null then
    select * into v_dup from meganet.field_photo where origin = v_origin and origin_ref = v_ref limit 1;
    if found then
      raise exception 'that % file has already been imported%', v_origin,
        case when v_dup.deleted_at is not null then ', and was since removed' else '' end
        using errcode = '23505', detail = v_dup.id::text;
    end if;
  end if;

  -- Where it was taken: both halves or neither, on the Earth, and how it was known.
  v_lat := (p_photo ->> 'lat')::numeric;
  v_lon := (p_photo ->> 'lon')::numeric;
  if (v_lat is null) <> (v_lon is null) then
    raise exception 'a position is a latitude and a longitude, or neither' using errcode = '22023';
  end if;
  v_place := nullif(p_photo ->> 'placement', '');
  if v_lat is not null then
    if v_place is null then
      raise exception 'a position needs to say where it came from (placement)' using errcode = '22023';
    end if;
    if not exists (select 1 from meganet.field_photo_placement where key = v_place) then
      raise exception '% is not a way a photo is placed', v_place using errcode = '23503',
        hint = 'see meganet.field_photo_placement';
    end if;
  elsif v_place is not null then
    raise exception 'a placement with no position' using errcode = '22023';
  end if;

  -- The station: the one sent, or — only when none was mentioned at all — the
  -- nearest within a kilometre. A station_id sent as null is somebody saying
  -- "none", which the nearest must not overrule.
  v_station := nullif(p_photo ->> 'station_id', '');
  if v_station is not null then
    if not exists (select 1 from meganet.station where id = v_station and deleted_at is null) then
      raise exception 'no such station: %', v_station using errcode = '23503';
    end if;
  elsif v_lat is not null and not (p_photo ? 'station_id') then
    v_station := meganet.field_photo_station_for(v_lat, v_lon);
    v_auto := v_station is not null;
  end if;

  -- Who. The caller, from the request — except that the sync, which runs as
  -- service_role, says whose Dropbox the photo came out of.
  v_by := meganet.actor();
  if v_by = 'service_role' and nullif(p_photo ->> 'uploaded_by', '') is not null then
    v_by := pg_catalog.left(p_photo ->> 'uploaded_by', 200);
  elsif nullif(p_photo ->> 'uploaded_by', '') is not null and p_photo ->> 'uploaded_by' <> v_by then
    raise exception 'uploaded_by is the caller''s, not something to send' using errcode = '42501';
  end if;

  begin
    v_taken := nullif(p_photo ->> 'taken_at', '')::timestamptz;
  exception when others then
    raise exception 'taken_at is not a time: %', p_photo ->> 'taken_at' using errcode = '22007';
  end;

  if p_photo ? 'meta' and pg_catalog.jsonb_typeof(p_photo -> 'meta') <> 'object' then
    raise exception 'meta has to be a JSON object' using errcode = '22023';
  end if;
  if pg_catalog.length((p_photo -> 'meta')::text) > 65536 then
    raise exception 'meta is over 64 kB — it is the record of what was read, not the reading itself' using errcode = '22023';
  end if;

  insert into meganet.field_photo (
      storage_path, thumb_path, content_type, byte_size, sha256, width, height,
      title, caption, taken_at, taken_local, taken_source,
      lat, lon, placement, accuracy_m, altitude_m, altitude_ref,
      heading_deg, heading_ref, pitch_deg, fov_deg,
      station_id, station_auto, meta, origin, origin_ref, uploaded_by)
  values (
      v_path, v_thumb, v_type.content_type, (p_photo ->> 'byte_size')::bigint, p_photo ->> 'sha256',
      (p_photo ->> 'width')::integer, (p_photo ->> 'height')::integer,
      pg_catalog.left(coalesce(p_photo ->> 'title', ''), 300), coalesce(p_photo ->> 'caption', ''),
      v_taken, nullif(p_photo ->> 'taken_local', ''), nullif(p_photo ->> 'taken_source', ''),
      v_lat, v_lon, v_place,
      (p_photo ->> 'accuracy_m')::numeric, (p_photo ->> 'altitude_m')::numeric, nullif(p_photo ->> 'altitude_ref', ''),
      (p_photo ->> 'heading_deg')::numeric, nullif(p_photo ->> 'heading_ref', ''),
      (p_photo ->> 'pitch_deg')::numeric, (p_photo ->> 'fov_deg')::numeric,
      v_station, v_auto, coalesce(p_photo -> 'meta', '{}'::jsonb), v_origin, v_ref, v_by)
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.add_field_photo(jsonb) is
  'Index one field photo already uploaded to the field-photos bucket. Editors only. Enforces the path convention, the type and size limits, one live row per SHA-256 and one row per origin file, matches the nearest station when none is sent, and stamps uploaded_by from the request.';

-- Change what a photo says about itself: its words, its time, where it was
-- taken and what it is of — never what or where its bytes are.
--
-- A patch, so "clear the caption" and "leave it alone" are different requests
-- (0010's reason). Moving a photo takes both halves of the position; the
-- placement becomes `manual` unless one is sent, the GPS's accuracy no longer
-- describes it and goes, and a station that was only ever picked by distance
-- is picked again — as is one for a photo that had no place until now, which
-- nobody can have filed anywhere: placed by hand, it is filed the way it would
-- have been had it come in with the position.
create or replace function meganet.update_field_photo(p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    meganet.field_photo%rowtype;
  v_key    text;
  v_moved  boolean;
  v_lat    numeric;
  v_lon    numeric;
  v_place  text;
  v_match  boolean;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to edit field photos' using errcode = '42501';
  end if;
  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'meganet.update_field_photo() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_patch) loop
    if v_key not in ('title', 'caption', 'taken_at', 'taken_source', 'lat', 'lon', 'placement',
                     'accuracy_m', 'heading_deg', 'heading_ref', 'pitch_deg', 'station_id') then
      raise exception 'meganet.update_field_photo() does not change %', v_key
        using errcode = '22023',
              hint    = 'title, caption, taken_at, taken_source, lat, lon, placement, accuracy_m, heading_deg, heading_ref, pitch_deg and station_id are the whole list';
    end if;
  end loop;

  select * into v_row from meganet.field_photo where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'no such field photo: %', p_id using errcode = 'P0002';
  end if;

  v_moved := p_patch ? 'lat' or p_patch ? 'lon';
  if v_moved then
    if not (p_patch ? 'lat' and p_patch ? 'lon') then
      raise exception 'moving a photo takes both its latitude and its longitude' using errcode = '22023';
    end if;
    v_lat := (p_patch ->> 'lat')::numeric;
    v_lon := (p_patch ->> 'lon')::numeric;
    if (v_lat is null) <> (v_lon is null) then
      raise exception 'a position is a latitude and a longitude, or neither' using errcode = '22023';
    end if;
    v_place := case when v_lat is null then null
                    else coalesce(nullif(p_patch ->> 'placement', ''), 'manual') end;
    if v_place is not null and not exists (select 1 from meganet.field_photo_placement where key = v_place) then
      raise exception '% is not a way a photo is placed', v_place using errcode = '23503';
    end if;
    v_match := not p_patch ? 'station_id'
               and (v_row.station_auto or (v_row.lat is null and v_row.station_id is null));
    v_row.lat := v_lat;
    v_row.lon := v_lon;
    v_row.placement := v_place;
    v_row.accuracy_m := case when p_patch ? 'accuracy_m' then (p_patch ->> 'accuracy_m')::numeric else null end;
    if v_match then
      v_row.station_id := case when v_lat is null then null else meganet.field_photo_station_for(v_lat, v_lon) end;
      v_row.station_auto := v_row.station_id is not null;
    end if;
  elsif p_patch ? 'placement' then
    raise exception 'a placement is changed by moving the photo (lat and lon with it)' using errcode = '22023';
  elsif p_patch ? 'accuracy_m' then
    v_row.accuracy_m := (p_patch ->> 'accuracy_m')::numeric;
  end if;

  if p_patch ? 'station_id' then
    if nullif(p_patch ->> 'station_id', '') is not null
       and not exists (select 1 from meganet.station where id = p_patch ->> 'station_id' and deleted_at is null) then
      raise exception 'no such station: %', p_patch ->> 'station_id' using errcode = '23503';
    end if;
    v_row.station_id := nullif(p_patch ->> 'station_id', '');
    v_row.station_auto := false;
  end if;

  if p_patch ? 'title'   then v_row.title   := pg_catalog.left(coalesce(p_patch ->> 'title', ''), 300); end if;
  if p_patch ? 'caption' then v_row.caption := coalesce(p_patch ->> 'caption', ''); end if;
  if p_patch ? 'taken_at' then
    begin
      v_row.taken_at := nullif(p_patch ->> 'taken_at', '')::timestamptz;
    exception when others then
      raise exception 'taken_at is not a time: %', p_patch ->> 'taken_at' using errcode = '22007';
    end;
    v_row.taken_source := case when v_row.taken_at is null then null
                               else coalesce(nullif(p_patch ->> 'taken_source', ''), 'manual') end;
  elsif p_patch ? 'taken_source' then
    v_row.taken_source := nullif(p_patch ->> 'taken_source', '');
  end if;
  if p_patch ? 'heading_deg' then v_row.heading_deg := (p_patch ->> 'heading_deg')::numeric; end if;
  if p_patch ? 'heading_ref' then v_row.heading_ref := nullif(p_patch ->> 'heading_ref', ''); end if;
  if p_patch ? 'pitch_deg'   then v_row.pitch_deg   := (p_patch ->> 'pitch_deg')::numeric; end if;

  update meganet.field_photo f
     set title = v_row.title, caption = v_row.caption,
         taken_at = v_row.taken_at, taken_source = v_row.taken_source,
         lat = v_row.lat, lon = v_row.lon, placement = v_row.placement, accuracy_m = v_row.accuracy_m,
         heading_deg = v_row.heading_deg, heading_ref = v_row.heading_ref, pitch_deg = v_row.pitch_deg,
         station_id = v_row.station_id, station_auto = v_row.station_auto,
         updated_by = meganet.actor()
   where f.id = p_id
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.update_field_photo(uuid, jsonb) is
  'Edit a field photo''s title, caption, time, position, heading or station. A patch. Never touches the objects it points at.';

-- Take a photo down, and say which objects are now unreferenced so the caller
-- can delete the bytes. The row stays as a tombstone (see the head of this
-- file). Removing something already removed is not an error — 0010's race.
create or replace function meganet.remove_field_photo(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.field_photo%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to remove field photos' using errcode = '42501';
  end if;

  update meganet.field_photo
     set deleted_at = pg_catalog.now(), deleted_by = meganet.actor()
   where id = p_id and deleted_at is null
  returning * into v_row;
  if not found then
    return pg_catalog.jsonb_build_object('removed', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'storage_bucket', v_row.storage_bucket,
    'storage_path', v_row.storage_path,
    'thumb_path', v_row.thumb_path);
end;
$$;

comment on function meganet.remove_field_photo(uuid) is
  'Soft-delete a field photo and return the objects it pointed at, so the caller can delete the bytes. The tombstone keeps a removed Dropbox photo from being imported again.';

-- ── Row level security ────────────────────────────────────────────────────────
-- Five tables, RLS in the same file (db/README.md). The two vocabularies are
-- public; the photos and the sync's report are editors only, and a tombstone
-- is nobody's to read but service_role's; the cursor has RLS and no policy at
-- all, so only a role that bypasses RLS reaches it.

alter table meganet.field_photo_origin      enable row level security;
alter table meganet.field_photo_placement   enable row level security;
alter table meganet.field_photo             enable row level security;
alter table meganet.field_photo_sync        enable row level security;
alter table meganet.field_photo_sync_cursor enable row level security;

drop policy if exists field_photo_origin_read_all on meganet.field_photo_origin;
create policy field_photo_origin_read_all on meganet.field_photo_origin for select using (true);
drop policy if exists field_photo_placement_read_all on meganet.field_photo_placement;
create policy field_photo_placement_read_all on meganet.field_photo_placement for select using (true);

drop policy if exists field_photo_read_editors on meganet.field_photo;
create policy field_photo_read_editors on meganet.field_photo
  for select to authenticated
  using (meganet.is_editor() and deleted_at is null);

drop policy if exists field_photo_sync_read_editors on meganet.field_photo_sync;
create policy field_photo_sync_read_editors on meganet.field_photo_sync
  for select to authenticated
  using (meganet.is_editor());

-- ── Who may run what ──────────────────────────────────────────────────────────
-- The three writers have EXECUTE revoked from public and granted back by name.
-- The station matcher only reads — the station table is public — but it is
-- revoked and granted the same way rather than left on the default, so the
-- list of what anon can call stays a list somebody wrote.

revoke all on function meganet.add_field_photo(jsonb)                              from public;
revoke all on function meganet.update_field_photo(uuid, jsonb)                     from public;
revoke all on function meganet.remove_field_photo(uuid)                            from public;
revoke all on function meganet.field_photo_station_for(numeric, numeric, numeric)  from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Said out loud, and re-said on every run, for 0010's reason: "the browser
  -- cannot write this table" should be a property a re-apply can restore.
  revoke insert, update, delete, truncate on meganet.field_photo from anon, authenticated;
  revoke all on meganet.field_photo from anon;
  revoke all on meganet.field_photo_sync from anon;
  revoke all on meganet.field_photo_sync_cursor from anon, authenticated;

  grant select on meganet.field_photo_origin, meganet.field_photo_placement to anon, authenticated;
  grant select on meganet.field_photo to authenticated;
  grant select on meganet.field_photo_sync to authenticated;

  grant select, insert, update, delete on
      meganet.field_photo_origin, meganet.field_photo_placement, meganet.field_photo,
      meganet.field_photo_sync, meganet.field_photo_sync_cursor
    to service_role;

  grant execute on function meganet.add_field_photo(jsonb)                             to authenticated, service_role;
  grant execute on function meganet.update_field_photo(uuid, jsonb)                    to authenticated, service_role;
  grant execute on function meganet.remove_field_photo(uuid)                           to authenticated, service_role;
  grant execute on function meganet.field_photo_station_for(numeric, numeric, numeric) to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 34 → 35 in the same commit as this file.
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '35')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
