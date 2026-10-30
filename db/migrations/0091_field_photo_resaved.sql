-- 0091_field_photo_resaved.sql — A Field Camera photo saved again by the phone
-- is the same photo, not a second one.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0091_field_photo_resaved.sql
--
-- Why this file exists
-- ────────────────────
-- On 29 Oct 2026 a Field Camera photo went up from an iPhone by itself, and
-- the phone also saved a copy of it into its photo library (the camera's
-- "Also save a copy" setting). The next day the library came up as an iCloud
-- zip through the Field Photos tab, and the copy went in beside the original
-- as IMG_3693.JPG. add_field_photo() refuses the same bytes twice (0035), but
-- iOS writes a photo afresh when it saves one — new bytes, a new hash — so
-- nothing stopped it.
--
-- What a re-saved copy keeps is what the Field Camera wrote into it: its
-- software ('Flood-Net Field Camera'), its time to the second and its place.
-- So add_field_photo() now also refuses a photo the Field Camera signed when
-- another of its photos here was taken within a second of it and within five
-- metres, with the same 23505 and the existing photo's id as the detail —
-- which every door already reads as "already in Flood-Net": the Field Photos
-- tab, the camera's own outbox and the Dropbox and Google Drive syncs. Two
-- photos the camera sent from its own outbox (each carries meta.capture,
-- which a file does not) are two presses of the shutter, and both are kept;
-- a removed photo stops nothing.
--
-- The rest of the function is 0035's, unchanged.

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

  -- The same Field Camera photo again, by another door (0091). A phone that
  -- saves a Field Camera photo into its library writes the file afresh — new
  -- bytes, so a new hash — but keeps its stamp, its second and its spot. So a
  -- photo the Field Camera signed, taken within a second of another of its
  -- photos here and within five metres of it, is that photo. Two the camera
  -- sent from its own outbox (each carries meta.capture, which a file does
  -- not) are two presses of the shutter, and both are kept.
  if v_taken is not null and v_lat is not null
     and p_photo -> 'meta' -> 'camera' ->> 'software' = 'Flood-Net Field Camera' then
    select * into v_dup from meganet.field_photo f
     where f.deleted_at is null
       and f.taken_at between v_taken - interval '1 second' and v_taken + interval '1 second'
       and f.lat is not null
       and f.meta -> 'camera' ->> 'software' = 'Flood-Net Field Camera'
       and not ((f.meta ? 'capture') and ((p_photo -> 'meta') ? 'capture'))
       and 111320 * pg_catalog.sqrt(pg_catalog.power((f.lat - v_lat)::float8, 2)
             + pg_catalog.power((f.lon - v_lon)::float8 * pg_catalog.cos(pg_catalog.radians(v_lat::float8)), 2)) <= 5
     order by f.created_at
     limit 1;
    if found then
      raise exception 'the phone saved this Field Camera photo again'
        using errcode = '23505',
              detail  = v_dup.id::text,
              hint    = pg_catalog.format('the one here was added by %s on %s',
                                          coalesce(nullif(v_dup.uploaded_by, ''), 'someone'),
                                          pg_catalog.to_char(v_dup.created_at, 'YYYY-MM-DD'));
    end if;
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
  'Index one field photo already uploaded to the field-photos bucket. Editors only. Enforces the path convention, the type and size limits, one live row per SHA-256 and one row per origin file, one live row per Field Camera photo however often the phone saved it again (0091), matches the nearest station when none is sent, and stamps uploaded_by from the request.';

notify pgrst, 'reload schema';

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes to 91 once this is applied (CLAUDE.md).
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '91')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
