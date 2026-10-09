-- 0060_level_surveys.sql — Level surveys and two-peg tests from the field, the
-- levels and staffs crews use, the pictures behind each reading, and what an
-- administrator adopts from a survey at its station: gauge zero, benchmarks,
-- the sensor reference, cease to flow, the boards, and the telemetry offset.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0060_level_surveys.sql
--
-- and then tools/storage_bucket.sql, which adds the `level-surveys` bucket the
-- pictures go in.
--
-- Why this file exists
-- ────────────────────
-- The Level Survey and Two-Peg Test tabs (level-survey.js, two-peg.js) book a
-- rise-and-fall run on a phone, reduce it as it is entered, and keep it on the
-- device until there is a signal. This is where a finished one goes, and the
-- line the owner drew around it: **anybody may survey a station and file the
-- survey under it; only an administrator changes the station from it.**
-- "Anybody" is anybody who may write at all — signed in, on the editors list
-- (is_editor(), 0004/0054) — because a survey is a record people rely on and
-- an anonymous one could not be asked a question. Signed out, the tabs still
-- book, reduce and export; the survey waits on the device.
--
--   1. level_equipment       the levels and staffs crews use, kept once and
--                            picked from a list rather than typed again: make,
--                            model, serial number, service date.
--   2. two_peg_test          a collimation check: four readings, and the error
--                            and pass worked out here from them (generated
--                            columns), not taken from the phone.
--   3. level_survey          a survey: the whole document the phone kept (doc),
--                            with the columns a list is drawn from, and ΣBS and
--                            ΣFS summed here from its rows — a survey that says
--                            it closed must have a misclose its own readings
--                            give (ΣBS − ΣFS), or it is refused.
--   4. level_evidence        each picture: the crop of a level's display a
--                            reading was taken from, a label read for a serial
--                            number, a photo of a point. The bytes are in the
--                            private `level-surveys` bucket, under the survey
--                            or test they belong to.
--   5. station_level_point,  what a station holds once an administrator
--      station_level_offset  adopts it: its benchmarks (one primary), sensor
--                            reference, cease to flow, gauge boards and other
--                            surveyed points, each current until a later survey
--                            supersedes it; and each change made to the
--                            logger's offset, with the survey that showed it.
--   6. level_survey_decision every administrator's decision on a survey —
--                            applied, or returned for completion — with each
--                            change's before and after. Station history (0056)
--                            logs the station's own columns only, and gauge
--                            zero is not one, so this is that record.
--   7. Gauge zero is an administrator's. It lives where it always has, in
--      station_gauge_survey (0031), and the apply writes a new row there from
--      the survey's date, closing the one before it — which also re-reads the
--      station's flood peaks into AHD through the new zero (0037's triggers).
--      save_station() is restated (0044's, plus one check): somebody who is not
--      an administrator may still correct a gauge-survey row's AMTD, catchment
--      area and note, but not its gauge zero, its datum or the dates it holds
--      between. The refusal carries detail 'administrator', as 0039's does, so
--      the editor says whose it is.
--
-- Reading: every table here is editors' (RLS), like the inspections — a
-- benchmark's description and a crew's names are not for the open internet,
-- and nothing here is in the agent API.
--
-- Depends on 0002 (station), 0004 (is_editor, actor, touch_updated_at), 0031
-- (station_gauge_survey, gauge_datum), 0036 (is_admin), 0044 (save_station).
-- tools/check_level_surveys.sql proves it.

-- ── 0. A number out of a document ────────────────────────────────────────────
-- A reading as the phone sent it — a JSON number, or a string holding one —
-- or null. Never an error: a survey's rows are checked by the sheet; here they
-- are summed.

create or replace function meganet.level_num(p jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
           when pg_catalog.jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric
           when pg_catalog.jsonb_typeof(p) = 'string'
                and (p #>> '{}') ~ '^\s*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)\s*$'
             then pg_catalog.btrim(p #>> '{}')::numeric
         end
$$;

comment on function meganet.level_num(jsonb) is
  'A JSON number, or a string holding one, as numeric; null for anything else. Internal to the level-survey functions (0060).';

-- ── 1. The equipment ─────────────────────────────────────────────────────────

create table if not exists meganet.level_equipment (
  id           uuid        primary key,
  kind         text        not null default 'level',
  make         text        not null default '',
  model        text        not null default '',
  serial       text        not null default '',
  service_date date,
  note         text        not null default '',
  created_by   text        not null,
  created_at   timestamptz not null default now(),
  updated_by   text        not null,
  updated_at   timestamptz not null default now(),
  retired_at   timestamptz,
  constraint level_equipment_kind check (kind in ('level', 'staff', 'other')),
  constraint level_equipment_says_something check (make <> '' or model <> '' or serial <> ''),
  constraint level_equipment_lengths check (length(make) <= 100 and length(model) <= 100
                                            and length(serial) <= 100 and length(note) <= 1000)
);

comment on table meganet.level_equipment is
  'Levels and staffs survey crews use (0060): make, model, serial number, service date. Kept once, picked from a list on the Level Survey and Two-Peg Test tabs. Editors read and write it through level_equipment_save(); retired_at takes a unit off the list.';

-- One live unit per serial number of a kind and make.
create unique index if not exists level_equipment_serial_live
  on meganet.level_equipment (kind, lower(make), lower(serial))
  where serial <> '' and retired_at is null;

-- ── 2. Two-peg tests ─────────────────────────────────────────────────────────

create table if not exists meganet.two_peg_test (
  id            uuid          primary key,
  equipment_id  uuid          references meganet.level_equipment (id) on delete set null,
  tested_on     date          not null,
  a1            numeric(8,4)  not null,
  b1            numeric(8,4)  not null,
  a2            numeric(8,4)  not null,
  b2            numeric(8,4)  not null,
  spacing_m     numeric(7,2),
  near_m        numeric(6,2),
  tolerance_m   numeric(6,4)  not null default 0.003,
  error_m       numeric(8,4)  generated always as (abs((a1 - b1) - (a2 - b2))) stored,
  passed        boolean       generated always as (abs((a1 - b1) - (a2 - b2)) <= tolerance_m) stored,
  doc           jsonb         not null,
  submitted_by  text          not null,
  submitted_at  timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),
  constraint two_peg_test_tolerance check (tolerance_m > 0 and tolerance_m <= 0.05),
  constraint two_peg_test_readings check (abs(a1) <= 10 and abs(b1) <= 10 and abs(a2) <= 10 and abs(b2) <= 10),
  constraint two_peg_test_geometry check ((spacing_m is null or spacing_m > 0) and (near_m is null or near_m >= 0)),
  constraint two_peg_test_doc check (jsonb_typeof(doc) = 'object' and octet_length(doc::text) <= 65536)
);

comment on table meganet.two_peg_test is
  'Two-peg tests of a level''s line of sight (0060). The four readings are columns; error_m and passed are worked out here from them. doc is the rest as the phone kept it (tester, organisation, the instrument as tested, location, action if failed).';

create index if not exists two_peg_test_equipment on meganet.two_peg_test (equipment_id, tested_on desc);

-- ── 3. Level surveys ─────────────────────────────────────────────────────────

create table if not exists meganet.level_survey (
  id               uuid          primary key,
  station_id       text          references meganet.station (id) on delete set null,
  station_number   text          not null default '',
  station_name     text          not null default '',
  survey_date      date          not null,
  datum            text          not null,
  bm_name          text          not null default '',
  bm_rl            numeric(9,4),
  gauge_zero_rl    numeric(9,4),
  equipment_id     uuid          references meganet.level_equipment (id) on delete set null,
  two_peg_test_id  uuid          references meganet.two_peg_test (id) on delete set null,
  rows_n           integer       not null default 0,
  sum_bs           numeric(10,4) not null default 0,
  sum_fs           numeric(10,4) not null default 0,
  misclose_m       numeric(8,4),
  tolerance_m      numeric(6,4)  not null default 0.003,
  outcome          text          not null default 'open',
  doc              jsonb         not null,
  status           text          not null default 'submitted',
  submitted_by     text          not null,
  submitted_at     timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,
  constraint level_survey_datum check (datum in ('AHD', 'ASSUMED', 'LGH')),
  constraint level_survey_outcome check (outcome in ('pass', 'fail', 'open')),
  constraint level_survey_status check (status in ('submitted', 'applied', 'returned')),
  constraint level_survey_tolerance check (tolerance_m > 0 and tolerance_m <= 0.05),
  constraint level_survey_says_where check (station_id is not null or station_number <> '' or station_name <> ''),
  constraint level_survey_doc check (jsonb_typeof(doc) = 'object' and octet_length(doc::text) <= 1048576)
);

comment on table meganet.level_survey is
  'Level surveys filed from the field (0060): the document the phone kept (doc — site, crew, kit, datum and control, every row of the run, the water check), with the columns a list is drawn from. sum_bs and sum_fs are summed here from doc''s rows, and a survey that says it closed carries the misclose they give. status: submitted, applied (an administrator adopted something from it — it can no longer be changed), returned (sent back for completion).';

create index if not exists level_survey_station on meganet.level_survey (station_id, survey_date desc);
create index if not exists level_survey_waiting on meganet.level_survey (status, submitted_at desc);

-- ── 4. The pictures ──────────────────────────────────────────────────────────

create table if not exists meganet.level_evidence (
  id               uuid          primary key,
  survey_id        uuid          references meganet.level_survey (id) on delete cascade,
  two_peg_test_id  uuid          references meganet.two_peg_test (id) on delete cascade,
  row_id           text,
  field            text,
  kind             text          not null,
  storage_path     text          not null,
  content_type     text          not null,
  byte_size        integer       not null,
  width            integer,
  height           integer,
  sha256           text,
  ocr_text         text,
  value_m          numeric(9,4),
  taken_at         timestamptz,
  lat              double precision,
  lon              double precision,
  accuracy_m       real,
  uploaded_by      text          not null,
  uploaded_at      timestamptz   not null default now(),
  constraint level_evidence_one_owner check (num_nonnulls(survey_id, two_peg_test_id) = 1),
  constraint level_evidence_kind check (kind in ('reading', 'photo', 'label')),
  constraint level_evidence_type check (content_type in ('image/webp', 'image/jpeg', 'image/png')),
  constraint level_evidence_size check (byte_size > 0 and byte_size <= 10485760),
  constraint level_evidence_path unique (storage_path),
  constraint level_evidence_field check (field is null or field ~ '^[a-z0-9_]{1,20}$'),
  constraint level_evidence_lengths check (length(coalesce(row_id, '')) <= 64 and length(coalesce(ocr_text, '')) <= 2000),
  constraint level_evidence_sha check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint level_evidence_place check ((lat is null or lat between -90 and 90) and (lon is null or lon between -180 and 180))
);

comment on table meganet.level_evidence is
  'The pictures behind a level survey or a two-peg test (0060): a crop of the level''s display a reading was taken from (kind reading, with the value accepted and what the OCR read), a label read for a serial number, or a photo of a point. Bytes in the private level-surveys bucket at <survey|two-peg>/<owner id>/<id>.<ext>.';

create index if not exists level_evidence_survey on meganet.level_evidence (survey_id) where survey_id is not null;
create index if not exists level_evidence_test on meganet.level_evidence (two_peg_test_id) where two_peg_test_id is not null;

-- ── 5. What a station holds ──────────────────────────────────────────────────

create table if not exists meganet.station_level_point (
  id             uuid          primary key default gen_random_uuid(),
  station_id     text          not null references meganet.station (id) on delete cascade,
  kind           text          not null,
  name           text          not null,
  is_primary     boolean       not null default false,
  rl             numeric(9,4),
  datum          text,
  rl_lgh         numeric(9,4),
  rl_ahd         numeric(9,4),
  face_value     numeric(7,3),
  approx         boolean       not null default false,
  description    text          not null default '',
  source         text          not null default '',
  lat            double precision,
  lon            double precision,
  survey_id      uuid          references meganet.level_survey (id) on delete set null,
  surveyed_on    date,
  adopted_by     text          not null,
  adopted_at     timestamptz   not null default now(),
  superseded_at  timestamptz,
  superseded_by  text,
  constraint station_level_point_kind check (kind in ('bm', 'ctr', 'ctf', 'board', 'slab', 'road', 'pit', 'other')),
  constraint station_level_point_datum check (datum is null or datum in ('AHD', 'ASSUM', 'LGH')),
  constraint station_level_point_name check (length(btrim(name)) between 1 and 100),
  constraint station_level_point_lengths check (length(description) <= 2000 and length(source) <= 500),
  constraint station_level_point_primary check (not is_primary or kind = 'bm'),
  constraint station_level_point_place check ((lat is null or lat between -90 and 90) and (lon is null or lon between -180 and 180))
);

comment on table meganet.station_level_point is
  'A station''s surveyed points as an administrator adopted them from a level survey (0060): benchmarks (one primary), the sensor reference (CTR), cease to flow, gauge boards and the rest — level in the survey''s datum, on the gauge (rl_lgh) and in AHD where known. One current row per kind and name; a later adoption supersedes it and the old row stays.';

create unique index if not exists station_level_point_current
  on meganet.station_level_point (station_id, kind, lower(name)) where superseded_at is null;

create table if not exists meganet.station_level_offset (
  id            uuid          primary key default gen_random_uuid(),
  station_id    text          not null references meganet.station (id) on delete cascade,
  valid_from    date          not null,
  correction_m  numeric(8,4)  not null,
  offset_m      numeric(9,4),
  sensor        text          not null default '',
  note          text          not null default '',
  survey_id     uuid          references meganet.level_survey (id) on delete set null,
  adopted_by    text          not null,
  adopted_at    timestamptz   not null default now(),
  constraint station_level_offset_size check (abs(correction_m) <= 10),
  constraint station_level_offset_lengths check (length(sensor) <= 100 and length(note) <= 1000)
);

comment on table meganet.station_level_offset is
  'Each change made to a station''s telemetry offset, as an administrator recorded it from a level survey''s water check (0060): the correction, the offset after it where known, which sensor, from when.';

create index if not exists station_level_offset_station on meganet.station_level_offset (station_id, valid_from desc);

create table if not exists meganet.level_survey_decision (
  id          uuid          primary key default gen_random_uuid(),
  survey_id   uuid          not null references meganet.level_survey (id) on delete cascade,
  station_id  text,
  decision    text          not null,
  changes     jsonb         not null default '[]'::jsonb,
  note        text          not null default '',
  decided_by  text          not null,
  decided_at  timestamptz   not null default now(),
  constraint level_survey_decision_kind check (decision in ('applied', 'returned')),
  constraint level_survey_decision_changes check (jsonb_typeof(changes) = 'array')
);

comment on table meganet.level_survey_decision is
  'Every administrator decision on a level survey (0060): applied — with each change''s before and after — or returned for completion, with why.';

create index if not exists level_survey_decision_survey on meganet.level_survey_decision (survey_id, decided_at);

-- updated_at, stamped the way every table with one is (0001).
do $$
declare
  t text;
begin
  foreach t in array array['level_equipment', 'two_peg_test', 'level_survey'] loop
    execute format('drop trigger if exists %I on meganet.%I', t || '_touch_updated_at', t);
    execute format('create trigger %I before update on meganet.%I
                      for each row execute function meganet.touch_updated_at()', t || '_touch_updated_at', t);
  end loop;
end
$$;

-- ── Row level security ───────────────────────────────────────────────────────
-- Editors read; nobody writes but through the functions below.

do $$
declare
  t text;
begin
  foreach t in array array['level_equipment', 'two_peg_test', 'level_survey', 'level_evidence',
                           'station_level_point', 'station_level_offset', 'level_survey_decision'] loop
    execute format('alter table meganet.%I enable row level security', t);
    execute format('drop policy if exists %I on meganet.%I', t || '_read_editors', t);
    execute format('create policy %I on meganet.%I for select to authenticated using (meganet.is_editor())',
                   t || '_read_editors', t);
  end loop;
end
$$;

-- ── 6. Keeping a level or a staff ────────────────────────────────────────────
-- Any editor: the list is the crews' own. The same unit entered on two phones
-- before either had a signal is one unit — the second is answered with the
-- first (duplicate_of), and the phone files its surveys under that.

create or replace function meganet.level_equipment_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   text := meganet.actor();
  v_key     text;
  v_id      uuid;
  v_kind    text;
  v_make    text;
  v_model   text;
  v_serial  text;
  v_note    text;
  v_service date;
  v_retire  boolean;
  v_row     meganet.level_equipment%rowtype;
  v_dup     meganet.level_equipment%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to keep survey equipment'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.level_equipment_save() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('id', 'kind', 'make', 'model', 'serial', 'service_date', 'note', 'retired') then
      raise exception 'meganet.level_equipment_save() does not take %', v_key
        using errcode = '22023',
              hint    = 'id, kind, make, model, serial, service_date, note and retired are the whole list';
    end if;
  end loop;
  begin
    v_id := (p ->> 'id')::uuid;
  exception when others then
    raise exception 'an item of equipment needs a uuid for its id, not %', coalesce(p ->> 'id', 'nothing') using errcode = '22023';
  end;
  if v_id is null then
    raise exception 'an item of equipment needs a uuid for its id' using errcode = '22023';
  end if;
  v_kind := coalesce(nullif(pg_catalog.btrim(p ->> 'kind'), ''), 'level');
  if v_kind not in ('level', 'staff', 'other') then
    raise exception 'equipment is a level, a staff or other, not %', v_kind using errcode = '22023';
  end if;
  v_make   := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'make', ''), '\s+', ' ', 'g'));
  v_model  := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'model', ''), '\s+', ' ', 'g'));
  v_serial := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'serial', ''), '\s+', ' ', 'g'));
  v_note   := pg_catalog.btrim(coalesce(p ->> 'note', ''));
  if v_make = '' and v_model = '' and v_serial = '' then
    raise exception 'an item of equipment needs a make, a model or a serial number' using errcode = '22023';
  end if;
  if pg_catalog.length(v_make) > 100 or pg_catalog.length(v_model) > 100 or pg_catalog.length(v_serial) > 100
     or pg_catalog.length(v_note) > 1000 then
    raise exception 'a make, model or serial number is at most 100 characters, a note 1,000' using errcode = '22023';
  end if;
  begin
    v_service := nullif(p ->> 'service_date', '')::date;
  exception when others then
    raise exception 'service_date has to be a date, not %', p ->> 'service_date' using errcode = '22023';
  end;
  v_retire := pg_catalog.lower(coalesce(p ->> 'retired', 'false')) in ('true', '1', 'yes');

  if v_serial <> '' and not exists (select 1 from meganet.level_equipment where id = v_id) then
    select * into v_dup from meganet.level_equipment e
     where e.kind = v_kind and pg_catalog.lower(e.make) = pg_catalog.lower(v_make)
       and pg_catalog.lower(e.serial) = pg_catalog.lower(v_serial) and e.retired_at is null
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object('equipment', pg_catalog.to_jsonb(v_dup), 'duplicate_of', v_dup.id);
    end if;
  end if;

  insert into meganet.level_equipment as e (id, kind, make, model, serial, service_date, note, created_by, updated_by, retired_at)
  values (v_id, v_kind, v_make, v_model, v_serial, v_service, v_note, v_actor, v_actor,
          case when v_retire then pg_catalog.now() end)
  on conflict (id) do update set
    kind = excluded.kind, make = excluded.make, model = excluded.model, serial = excluded.serial,
    service_date = excluded.service_date, note = excluded.note, updated_by = v_actor,
    retired_at = case when v_retire then coalesce(e.retired_at, pg_catalog.now()) end
  returning * into v_row;
  return pg_catalog.jsonb_build_object('equipment', pg_catalog.to_jsonb(v_row));
exception
  when unique_violation then
    raise exception 'another % already has the serial number %', v_kind, v_serial
      using errcode = '23505',
            hint    = 'pick that one from the list, or retire it first';
end;
$$;

comment on function meganet.level_equipment_save(jsonb) is
  'Keep a level or a staff (0060): {id, kind, make, model, serial, service_date, note, retired}. Editors. A new unit whose kind, make and serial number are already live is answered with that one (duplicate_of) rather than added twice.';

-- ── 7. Filing a two-peg test ─────────────────────────────────────────────────

create or replace function meganet.two_peg_test_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := meganet.actor();
  v_doc   jsonb;
  v_id    uuid;
  v_date  date;
  v_a1    numeric;
  v_b1    numeric;
  v_a2    numeric;
  v_b2    numeric;
  v_tol   numeric;
  v_span  numeric;
  v_near  numeric;
  v_eq    uuid;
  v_old   meganet.two_peg_test%rowtype;
  v_row   meganet.two_peg_test%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to file a two-peg test'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.two_peg_test_save() needs the test as a JSON object' using errcode = '22023';
  end if;
  v_doc := p - 'sync';
  if pg_catalog.octet_length(v_doc::text) > 65536 then
    raise exception 'a two-peg test is at most 64 kB of JSON' using errcode = '22023';
  end if;
  if coalesce(v_doc ->> 'type', '') <> 'two-peg' then
    raise exception 'that is not a two-peg test (type %)', coalesce(v_doc ->> 'type', 'missing') using errcode = '22023';
  end if;
  if pg_catalog.lower(coalesce(v_doc ->> 'practice', 'false')) = 'true' then
    raise exception 'a practice test is not a record — it stays on the device' using errcode = '22023';
  end if;
  begin
    v_id := (v_doc ->> 'id')::uuid;
    v_date := (v_doc ->> 'date')::date;
  exception when others then
    raise exception 'a two-peg test needs a uuid id and a date' using errcode = '22023';
  end;
  if v_id is null or v_date is null then
    raise exception 'a two-peg test needs a uuid id and a date' using errcode = '22023';
  end if;
  if v_date > current_date + 1 then
    raise exception 'a two-peg test dated % has not happened yet', v_date using errcode = '22023';
  end if;
  v_a1 := meganet.level_num(v_doc -> 'a1');
  v_b1 := meganet.level_num(v_doc -> 'b1');
  v_a2 := meganet.level_num(v_doc -> 'a2');
  v_b2 := meganet.level_num(v_doc -> 'b2');
  if v_a1 is null or v_b1 is null or v_a2 is null or v_b2 is null then
    raise exception 'a two-peg test is all four readings — A and B from both set-ups' using errcode = '22023';
  end if;
  if pg_catalog.abs(v_a1) > 10 or pg_catalog.abs(v_b1) > 10 or pg_catalog.abs(v_a2) > 10 or pg_catalog.abs(v_b2) > 10 then
    raise exception 'a staff reading is in metres — % is not one', pg_catalog.greatest(pg_catalog.abs(v_a1), pg_catalog.abs(v_b1), pg_catalog.abs(v_a2), pg_catalog.abs(v_b2))
      using errcode = '22023';
  end if;
  v_tol := coalesce(meganet.level_num(v_doc -> 'tol'), 0.003);
  if v_tol <= 0 or v_tol > 0.05 then
    raise exception 'a tolerance of % m is not one a two-peg test is held to', v_tol using errcode = '22023';
  end if;
  v_span := meganet.level_num(v_doc -> 'spacing');
  v_near := meganet.level_num(v_doc -> 'near');
  if (v_span is not null and (v_span <= 0 or v_span > 99999)) or (v_near is not null and (v_near < 0 or v_near > 9999)) then
    raise exception 'the peg spacing and set-up distance are metres, more than nothing' using errcode = '22023';
  end if;
  begin
    v_eq := nullif(v_doc #>> '{instrument,id}', '')::uuid;
  exception when others then
    v_eq := null;
  end;
  if v_eq is not null and not exists (select 1 from meganet.level_equipment where id = v_eq) then
    v_eq := null;
  end if;

  select * into v_old from meganet.two_peg_test where id = v_id for update;
  if found and v_old.submitted_by is distinct from v_actor and not meganet.is_admin() then
    raise exception 'this test was filed by %; only they or an administrator may change it', v_old.submitted_by
      using errcode = '42501';
  end if;

  insert into meganet.two_peg_test as t (id, equipment_id, tested_on, a1, b1, a2, b2, spacing_m, near_m, tolerance_m, doc, submitted_by)
  values (v_id, v_eq, v_date, v_a1, v_b1, v_a2, v_b2, v_span, v_near, v_tol, v_doc, v_actor)
  on conflict (id) do update set
    equipment_id = excluded.equipment_id, tested_on = excluded.tested_on,
    a1 = excluded.a1, b1 = excluded.b1, a2 = excluded.a2, b2 = excluded.b2,
    spacing_m = excluded.spacing_m, near_m = excluded.near_m, tolerance_m = excluded.tolerance_m, doc = excluded.doc
  returning * into v_row;
  return pg_catalog.jsonb_build_object('test', pg_catalog.to_jsonb(v_row) - 'doc');
end;
$$;

comment on function meganet.two_peg_test_save(jsonb) is
  'File a two-peg test (0060): the document the Two-Peg Test tab kept. Editors; a test filed by somebody else is theirs or an administrator''s to change. Practice tests are refused. Answers {test} with error_m and passed as worked out here.';

-- ── 8. Filing a level survey ─────────────────────────────────────────────────
-- The phone's document, whole. What the database checks is what it can check
-- without booking the run again: who and what the survey is of, its size, and
-- that a survey saying it closed has the misclose its own readings give —
-- ΣBS − ΣFS, which is what closing on the opening benchmark makes it. The
-- sheet's other checks (the rows' shape, the boards, the water check) are
-- level-survey.js's and travel in doc.result.

create or replace function meganet.level_survey_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   text := meganet.actor();
  v_doc     jsonb;
  v_id      uuid;
  v_date    date;
  v_datum   text;
  v_station text;
  v_number  text;
  v_name    text;
  v_res     jsonb;
  v_closed  boolean;
  v_bs      numeric;
  v_fs      numeric;
  v_n       integer;
  v_said    numeric;
  v_mis     numeric;
  v_tol     numeric;
  v_outcome text;
  v_eq      uuid;
  v_test    uuid;
  v_old     meganet.level_survey%rowtype;
  v_row     meganet.level_survey%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to file a level survey'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.level_survey_save() needs the survey as a JSON object' using errcode = '22023';
  end if;
  v_doc := p - 'sync';
  if pg_catalog.octet_length(v_doc::text) > 1048576 then
    raise exception 'a level survey is at most 1 MB of JSON — its pictures travel separately' using errcode = '22023';
  end if;
  if coalesce(v_doc ->> 'type', '') <> 'level-survey' then
    raise exception 'that is not a level survey (type %)', coalesce(v_doc ->> 'type', 'missing') using errcode = '22023';
  end if;
  if pg_catalog.lower(coalesce(v_doc ->> 'practice', 'false')) = 'true' then
    raise exception 'a practice survey is not a record — it stays on the device' using errcode = '22023';
  end if;
  begin
    v_id := (v_doc ->> 'id')::uuid;
    v_date := (v_doc ->> 'date')::date;
  exception when others then
    raise exception 'a level survey needs a uuid id and a date' using errcode = '22023';
  end;
  if v_id is null or v_date is null then
    raise exception 'a level survey needs a uuid id and a date' using errcode = '22023';
  end if;
  if v_date > current_date + 1 then
    raise exception 'a survey dated % has not happened yet', v_date using errcode = '22023';
  end if;
  v_datum := coalesce(v_doc ->> 'datum', '');
  if v_datum not in ('AHD', 'ASSUMED', 'LGH') then
    raise exception 'a survey''s datum is AHD, ASSUMED or LGH, not %', coalesce(nullif(v_datum, ''), 'nothing') using errcode = '22023';
  end if;

  v_station := nullif(pg_catalog.btrim(coalesce(v_doc #>> '{station,id}', '')), '');
  v_number  := pg_catalog.left(pg_catalog.btrim(coalesce(v_doc #>> '{station,number}', '')), 40);
  v_name    := pg_catalog.left(pg_catalog.btrim(coalesce(v_doc #>> '{station,name}', '')), 200);
  if v_station is not null and not exists (select 1 from meganet.station where id = v_station) then
    raise exception 'no such station: %', v_station using errcode = '23503';
  end if;
  if v_station is null and v_number = '' and v_name = '' then
    raise exception 'a survey has to say which station it is of' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_doc -> 'rows') is distinct from 'array' then
    raise exception 'a survey''s rows are a list' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_doc -> 'rows') > 500 then
    raise exception 'a survey of more than 500 rows is two surveys' using errcode = '22023';
  end if;
  select coalesce(sum(meganet.level_num(r -> 'bs')), 0), coalesce(sum(meganet.level_num(r -> 'fs')), 0), count(*)
    into v_bs, v_fs, v_n
    from pg_catalog.jsonb_array_elements(v_doc -> 'rows') r;

  v_tol := coalesce(meganet.level_num(v_doc #> '{tol,misclose}'), 0.003);
  if v_tol <= 0 or v_tol > 0.05 then
    raise exception 'a misclose tolerance of % m is not one a survey is held to', v_tol using errcode = '22023';
  end if;
  v_res := coalesce(v_doc -> 'result', '{}'::jsonb);
  v_closed := pg_catalog.lower(coalesce(v_res ->> 'closed', 'false')) = 'true';
  if v_closed then
    v_mis := v_bs - v_fs;
    v_said := meganet.level_num(v_res -> 'misclose');
    if v_said is null or pg_catalog.abs(v_said - v_mis) > 0.00005 then
      raise exception 'the sheet''s misclose (%) is not what its readings give (ΣBS − ΣFS = %)', coalesce(v_res ->> 'misclose', 'none'), v_mis
        using errcode = '22023',
              hint    = 'the rows and the result disagree — open the survey and save it again';
    end if;
    v_outcome := case when pg_catalog.abs(v_mis) <= v_tol then 'pass' else 'fail' end;
  else
    v_outcome := 'open';
  end if;

  begin
    v_eq := nullif(v_doc #>> '{instrument,id}', '')::uuid;
  exception when others then
    v_eq := null;
  end;
  if v_eq is not null and not exists (select 1 from meganet.level_equipment where id = v_eq) then
    v_eq := null;
  end if;
  begin
    v_test := nullif(v_doc #>> '{peg_test,id}', '')::uuid;
  exception when others then
    v_test := null;
  end;
  if v_test is not null and not exists (select 1 from meganet.two_peg_test where id = v_test) then
    v_test := null;
  end if;

  select * into v_old from meganet.level_survey where id = v_id for update;
  if found then
    if v_old.submitted_by is distinct from v_actor and not meganet.is_admin() then
      raise exception 'this survey was filed by %; only they or an administrator may change it', v_old.submitted_by
        using errcode = '42501';
    end if;
    if v_old.status = 'applied' then
      raise exception 'this survey was applied to its station by % on %; it is a record now and does not change',
        coalesce(v_old.decided_by, 'an administrator'), pg_catalog.to_char(v_old.decided_at, 'YYYY-MM-DD')
        using errcode = '55000',
              hint    = 'a correction is a new survey';
    end if;
  end if;

  insert into meganet.level_survey as s (
    id, station_id, station_number, station_name, survey_date, datum, bm_name, bm_rl, gauge_zero_rl,
    equipment_id, two_peg_test_id, rows_n, sum_bs, sum_fs, misclose_m, tolerance_m, outcome, doc, status, submitted_by)
  values (
    v_id, v_station, v_number, v_name, v_date, v_datum,
    pg_catalog.left(pg_catalog.btrim(coalesce(v_doc #>> '{bm,name}', '')), 100),
    meganet.level_num(v_doc #> '{bm,rl}'), meganet.level_num(v_res -> 'gauge_zero'),
    v_eq, v_test, v_n, v_bs, v_fs, v_mis, v_tol, v_outcome, v_doc, 'submitted', v_actor)
  on conflict (id) do update set
    station_id = excluded.station_id, station_number = excluded.station_number, station_name = excluded.station_name,
    survey_date = excluded.survey_date, datum = excluded.datum, bm_name = excluded.bm_name, bm_rl = excluded.bm_rl,
    gauge_zero_rl = excluded.gauge_zero_rl, equipment_id = excluded.equipment_id, two_peg_test_id = excluded.two_peg_test_id,
    rows_n = excluded.rows_n, sum_bs = excluded.sum_bs, sum_fs = excluded.sum_fs, misclose_m = excluded.misclose_m,
    tolerance_m = excluded.tolerance_m, outcome = excluded.outcome, doc = excluded.doc, status = 'submitted'
  returning * into v_row;
  return pg_catalog.jsonb_build_object('survey', pg_catalog.to_jsonb(v_row) - 'doc');
end;
$$;

comment on function meganet.level_survey_save(jsonb) is
  'File a level survey (0060): the document the Level Survey tab kept. Editors; a survey filed by somebody else is theirs or an administrator''s to change, and an applied one is not changed at all (55000). A closed survey''s misclose must be ΣBS − ΣFS of its own rows (22023 otherwise); outcome is pass or fail against its tolerance. Sending a returned survey again puts it back in the queue.';

-- ── 9. A picture, once its bytes are in the bucket ───────────────────────────

create or replace function meganet.level_evidence_add(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  text := meganet.actor();
  v_key    text;
  v_id     uuid;
  v_owner  text;
  v_oid    uuid;
  v_by     text;
  v_type   text;
  v_ext    text;
  v_path   text;
  v_size   integer;
  v_taken  timestamptz;
  v_row    meganet.level_evidence%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to add a survey''s pictures'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.level_evidence_add() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('id', 'owner', 'owner_id', 'row_id', 'field', 'kind', 'storage_path', 'content_type', 'byte_size',
                     'width', 'height', 'sha256', 'ocr_text', 'value_m', 'taken_at', 'lat', 'lon', 'accuracy_m') then
      raise exception 'meganet.level_evidence_add() does not take %', v_key using errcode = '22023';
    end if;
  end loop;
  begin
    v_id := (p ->> 'id')::uuid;
    v_oid := (p ->> 'owner_id')::uuid;
  exception when others then
    raise exception 'a picture and what it belongs to are each named by a uuid' using errcode = '22023';
  end;
  v_owner := coalesce(p ->> 'owner', '');
  if v_id is null or v_oid is null or v_owner not in ('survey', 'two-peg') then
    raise exception 'a picture belongs to a survey or a two-peg test, named by its id' using errcode = '22023';
  end if;
  if v_owner = 'survey' then
    select submitted_by into v_by from meganet.level_survey where id = v_oid;
  else
    select submitted_by into v_by from meganet.two_peg_test where id = v_oid;
  end if;
  if not found then
    raise exception 'no such % — file it before its pictures', case when v_owner = 'survey' then 'survey' else 'two-peg test' end
      using errcode = '23503';
  end if;
  if v_by is distinct from v_actor and not meganet.is_admin() then
    raise exception 'that % was filed by somebody else', case when v_owner = 'survey' then 'survey' else 'two-peg test' end
      using errcode = '42501';
  end if;
  v_type := coalesce(p ->> 'content_type', '');
  v_ext := case v_type when 'image/webp' then 'webp' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' end;
  if v_ext is null then
    raise exception 'a survey''s picture is WebP, JPEG or PNG, not %', coalesce(nullif(v_type, ''), 'nothing') using errcode = '22023';
  end if;
  v_path := pg_catalog.format('%s/%s/%s.%s', v_owner, v_oid, v_id, v_ext);
  if coalesce(p ->> 'storage_path', '') <> v_path then
    raise exception 'the picture is filed at %, not %', v_path, coalesce(p ->> 'storage_path', 'nowhere')
      using errcode = '22023';
  end if;
  begin
    v_size := (p ->> 'byte_size')::integer;
    v_taken := nullif(p ->> 'taken_at', '')::timestamptz;
  exception when others then
    raise exception 'byte_size is a whole number and taken_at a time' using errcode = '22023';
  end;

  insert into meganet.level_evidence (
    id, survey_id, two_peg_test_id, row_id, field, kind, storage_path, content_type, byte_size, width, height,
    sha256, ocr_text, value_m, taken_at, lat, lon, accuracy_m, uploaded_by)
  values (
    v_id, case when v_owner = 'survey' then v_oid end, case when v_owner = 'two-peg' then v_oid end,
    nullif(pg_catalog.left(coalesce(p ->> 'row_id', ''), 64), ''), nullif(p ->> 'field', ''), coalesce(p ->> 'kind', ''),
    v_path, v_type, v_size, meganet.level_num(p -> 'width')::integer, meganet.level_num(p -> 'height')::integer,
    nullif(p ->> 'sha256', ''), nullif(pg_catalog.left(coalesce(p ->> 'ocr_text', ''), 2000), ''),
    meganet.level_num(p -> 'value_m'), v_taken,
    meganet.level_num(p -> 'lat')::double precision, meganet.level_num(p -> 'lon')::double precision,
    meganet.level_num(p -> 'accuracy_m')::real, v_actor)
  on conflict (id) do nothing;
  select * into v_row from meganet.level_evidence where id = v_id;
  return pg_catalog.jsonb_build_object('evidence', pg_catalog.to_jsonb(v_row));
exception
  when check_violation then
    raise exception 'that picture''s record is not one this table keeps (%)', sqlerrm using errcode = '22023';
end;
$$;

comment on function meganet.level_evidence_add(jsonb) is
  'Record a picture behind a level survey or a two-peg test once its bytes are in the level-surveys bucket (0060). Editors, for their own survey or test (an administrator for any). The path is <survey|two-peg>/<owner id>/<id>.<webp|jpg|png> and nothing else. Sending it again changes nothing.';

-- ── 10. An administrator decides ─────────────────────────────────────────────
-- Applying is a list of changes, each one the administrator ticked:
--
--   { key, kind: 'gauge_zero', value: { gauge_zero_m, datum, valid_from, note } }
--       a new row in station_gauge_survey from valid_from, the open one closed
--       the day before it (or replaced, if it opened the same day); its AMTD and
--       catchment area carried forward. Never behind a later gauge zero.
--   { key, kind: 'point', value: { kind, name, primary, rl, datum, rl_lgh,
--       rl_ahd, face_value, approx, description, source, lat, lon } }
--       the station's current point of that kind and name superseded by this.
--   { key, kind: 'offset', value: { correction_m, offset_m, valid_from, sensor,
--       note } }
--       a change made to the logger's offset, recorded.
--
-- One transaction: refused anywhere, nothing changes. Each change's before and
-- after goes in the decision's log.

create or replace function meganet.level_survey_apply(p_survey uuid, p_changes jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    text := meganet.actor();
  v_note     text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_s        meganet.level_survey%rowtype;
  v_c        jsonb;
  v_v        jsonb;
  v_kind     text;
  v_log      jsonb := '[]'::jsonb;
  v_before   jsonb;
  v_after    jsonb;
  v_from     date;
  v_gz       numeric;
  v_datum    text;
  v_ord      integer;
  v_open     meganet.station_gauge_survey%rowtype;
  v_has_open boolean;
  v_gnote    text;
  v_pkind    text;
  v_name     text;
  v_primary  boolean;
  v_pt       meganet.station_level_point%rowtype;
  v_new      meganet.station_level_point%rowtype;
  v_corr     numeric;
  v_off      meganet.station_level_offset%rowtype;
  v_dec      meganet.level_survey_decision%rowtype;
  v_touched  boolean := false;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator applies a survey to its station'
      using errcode = '42501',
            detail  = 'administrator',
            hint    = 'the survey is filed — an administrator reviews it and decides what the station takes from it';
  end if;
  select * into v_s from meganet.level_survey where id = p_survey for update;
  if not found then
    raise exception 'no such level survey: %', p_survey using errcode = 'P0002';
  end if;
  if v_s.station_id is null then
    raise exception 'that survey is not filed under a station in Flood-Net — file it under one first' using errcode = '22023';
  end if;
  if v_s.status = 'returned' then
    raise exception 'that survey was returned for completion; it is applied once it is sent again' using errcode = '55000';
  end if;
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'array' or pg_catalog.jsonb_array_length(p_changes) = 0 then
    raise exception 'nothing to apply — tick what the station takes from the survey' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_changes) > 100 then
    raise exception 'at most 100 changes at once' using errcode = '22023';
  end if;
  if pg_catalog.length(coalesce(v_note, '')) > 1000 then
    raise exception 'a decision''s note is at most 1,000 characters' using errcode = '22023';
  end if;

  for v_c in select x from pg_catalog.jsonb_array_elements(p_changes) x loop
    v_kind := coalesce(v_c ->> 'kind', '');
    v_v := coalesce(v_c -> 'value', '{}'::jsonb);
    v_before := null;

    if v_kind = 'gauge_zero' then
      v_gz := meganet.level_num(v_v -> 'gauge_zero_m');
      v_datum := coalesce(v_v ->> 'datum', '');
      begin
        v_from := coalesce(nullif(v_v ->> 'valid_from', '')::date, v_s.survey_date);
      exception when others then
        raise exception 'a gauge zero''s valid_from is a date' using errcode = '22023';
      end;
      if v_gz is null or pg_catalog.abs(v_gz) >= 10000 then
        raise exception 'a gauge zero is a level in metres' using errcode = '22023';
      end if;
      if not exists (select 1 from meganet.gauge_datum where code = v_datum) then
        raise exception 'a gauge zero''s datum is one meganet.gauge_datum knows, not %', coalesce(nullif(v_datum, ''), 'nothing')
          using errcode = '22023';
      end if;
      if exists (select 1 from meganet.station_gauge_survey g
                  where g.station_id = v_s.station_id and g.gauge_zero_m is not null and g.valid_from > v_from) then
        raise exception 'the station already has a gauge zero from a date after %; this one would go behind it', v_from
          using errcode = '22023',
                hint    = 'apply the later survey''s gauge zero, or correct the station''s gauge survey list';
      end if;
      v_gnote := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_v ->> 'note'), ''),
                                          pg_catalog.format('Level survey %s', v_s.survey_date)), 500);
      select * into v_open from meganet.station_gauge_survey g
       where g.station_id = v_s.station_id and g.valid_to is null and g.gauge_zero_m is not null
       order by g.valid_from desc nulls last, g.ord desc
       limit 1;
      v_has_open := found;
      if v_has_open then
        v_before := pg_catalog.jsonb_build_object('gauge_zero_m', v_open.gauge_zero_m, 'datum', v_open.datum,
                                                  'valid_from', v_open.valid_from, 'ord', v_open.ord);
      end if;
      if v_has_open and v_open.valid_from = v_from then
        update meganet.station_gauge_survey
           set gauge_zero_m = v_gz, datum = v_datum, note = v_gnote, updated_by = v_actor
         where station_id = v_s.station_id and ord = v_open.ord;
      else
        if v_has_open then
          update meganet.station_gauge_survey
             set valid_to = v_from - 1, updated_by = v_actor
           where station_id = v_s.station_id and ord = v_open.ord;
        end if;
        select coalesce(max(ord), -1) + 1 into v_ord from meganet.station_gauge_survey where station_id = v_s.station_id;
        insert into meganet.station_gauge_survey (station_id, ord, valid_from, valid_to, gauge_zero_m, datum,
                                                  amtd_km, catchment_area_km2, note, updated_by)
        values (v_s.station_id, v_ord, v_from, null, v_gz, v_datum,
                case when v_has_open then v_open.amtd_km end, case when v_has_open then v_open.catchment_area_km2 end,
                v_gnote, v_actor);
      end if;
      v_after := pg_catalog.jsonb_build_object('gauge_zero_m', v_gz, 'datum', v_datum, 'valid_from', v_from);
      v_touched := true;

    elsif v_kind = 'point' then
      v_pkind := coalesce(v_v ->> 'kind', '');
      v_name := pg_catalog.btrim(coalesce(v_v ->> 'name', ''));
      v_primary := pg_catalog.lower(coalesce(v_v ->> 'primary', 'false')) = 'true';
      if v_pkind not in ('bm', 'ctr', 'ctf', 'board', 'slab', 'road', 'pit', 'other') then
        raise exception 'a station point is a bm, ctr, ctf, board, slab, road, pit or other, not %', coalesce(nullif(v_pkind, ''), 'nothing')
          using errcode = '22023';
      end if;
      if v_name = '' or pg_catalog.length(v_name) > 100 then
        raise exception 'a station point needs a name of at most 100 characters' using errcode = '22023';
      end if;
      select * into v_pt from meganet.station_level_point p
       where p.station_id = v_s.station_id and p.kind = v_pkind and pg_catalog.lower(p.name) = pg_catalog.lower(v_name)
         and p.superseded_at is null
       for update;
      if found then
        v_before := pg_catalog.to_jsonb(v_pt);
        update meganet.station_level_point set superseded_at = pg_catalog.now(), superseded_by = v_actor where id = v_pt.id;
      end if;
      if v_primary and v_pkind = 'bm' then
        update meganet.station_level_point set is_primary = false
         where station_id = v_s.station_id and kind = 'bm' and is_primary and superseded_at is null;
      end if;
      insert into meganet.station_level_point (station_id, kind, name, is_primary, rl, datum, rl_lgh, rl_ahd, face_value, approx,
                                               description, source, lat, lon, survey_id, surveyed_on, adopted_by)
      values (v_s.station_id, v_pkind, v_name, v_primary and v_pkind = 'bm',
              meganet.level_num(v_v -> 'rl'), nullif(v_v ->> 'datum', ''),
              meganet.level_num(v_v -> 'rl_lgh'), meganet.level_num(v_v -> 'rl_ahd'), meganet.level_num(v_v -> 'face_value'),
              pg_catalog.lower(coalesce(v_v ->> 'approx', 'false')) = 'true',
              pg_catalog.left(coalesce(v_v ->> 'description', ''), 2000), pg_catalog.left(coalesce(v_v ->> 'source', ''), 500),
              meganet.level_num(v_v -> 'lat')::double precision, meganet.level_num(v_v -> 'lon')::double precision,
              v_s.id, v_s.survey_date, v_actor)
      returning * into v_new;
      v_after := pg_catalog.to_jsonb(v_new);

    elsif v_kind = 'offset' then
      v_corr := meganet.level_num(v_v -> 'correction_m');
      if v_corr is null or pg_catalog.abs(v_corr) > 10 then
        raise exception 'an offset correction is a change in metres' using errcode = '22023';
      end if;
      begin
        v_from := coalesce(nullif(v_v ->> 'valid_from', '')::date, v_s.survey_date);
      exception when others then
        raise exception 'an offset''s valid_from is a date' using errcode = '22023';
      end;
      insert into meganet.station_level_offset (station_id, valid_from, correction_m, offset_m, sensor, note, survey_id, adopted_by)
      values (v_s.station_id, v_from, v_corr, meganet.level_num(v_v -> 'offset_m'),
              pg_catalog.left(coalesce(v_v ->> 'sensor', ''), 100), pg_catalog.left(coalesce(v_v ->> 'note', ''), 1000),
              v_s.id, v_actor)
      returning * into v_off;
      v_after := pg_catalog.to_jsonb(v_off);

    else
      raise exception 'a change is a gauge_zero, a point or an offset, not %', coalesce(nullif(v_kind, ''), 'nothing')
        using errcode = '22023';
    end if;

    v_log := v_log || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
               'key', v_c ->> 'key', 'kind', v_kind, 'before', v_before, 'after', v_after));
  end loop;

  -- A new gauge zero moves the station's stamp, so an editor who had it open
  -- before is told to reload rather than saving the old list back over it.
  if v_touched then
    update meganet.station set updated_by = v_actor where id = v_s.station_id;
  end if;

  insert into meganet.level_survey_decision (survey_id, station_id, decision, changes, note, decided_by)
  values (v_s.id, v_s.station_id, 'applied', v_log, coalesce(v_note, ''), v_actor)
  returning * into v_dec;
  update meganet.level_survey
     set status = 'applied', decided_by = v_actor, decided_at = pg_catalog.now(), decision_note = v_note
   where id = v_s.id
  returning * into v_s;
  return pg_catalog.jsonb_build_object('survey', pg_catalog.to_jsonb(v_s) - 'doc', 'decision', pg_catalog.to_jsonb(v_dec));
end;
$$;

comment on function meganet.level_survey_apply(uuid, jsonb, text) is
  'Apply what an administrator ticked from a level survey to its station (0060): gauge zero (a new station_gauge_survey row from the survey''s date), points (benchmarks, CTR, CTF, boards — the current one superseded) and offset corrections. Administrators only (42501, detail administrator). One transaction, logged in level_survey_decision with each change''s before and after; the survey becomes applied and no longer changes.';

create or replace function meganet.level_survey_return(p_survey uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := meganet.actor();
  v_note  text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_s     meganet.level_survey%rowtype;
  v_dec   meganet.level_survey_decision%rowtype;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator returns a survey for completion'
      using errcode = '42501',
            detail  = 'administrator';
  end if;
  if v_note is null or pg_catalog.length(v_note) > 1000 then
    raise exception 'say what the survey needs before it can be used — in at most 1,000 characters' using errcode = '22023';
  end if;
  select * into v_s from meganet.level_survey where id = p_survey for update;
  if not found then
    raise exception 'no such level survey: %', p_survey using errcode = 'P0002';
  end if;
  if v_s.status <> 'submitted' then
    raise exception 'that survey is %, not waiting for a decision', v_s.status using errcode = '55000';
  end if;
  insert into meganet.level_survey_decision (survey_id, station_id, decision, changes, note, decided_by)
  values (v_s.id, v_s.station_id, 'returned', '[]'::jsonb, v_note, v_actor)
  returning * into v_dec;
  update meganet.level_survey
     set status = 'returned', decided_by = v_actor, decided_at = pg_catalog.now(), decision_note = v_note
   where id = v_s.id
  returning * into v_s;
  return pg_catalog.jsonb_build_object('survey', pg_catalog.to_jsonb(v_s) - 'doc', 'decision', pg_catalog.to_jsonb(v_dec));
end;
$$;

comment on function meganet.level_survey_return(uuid, text) is
  'Send a filed level survey back for completion, saying why (0060). Administrators only. Its crew sees the note, completes it and sends it again, which puts it back in the queue.';

-- ── 11. save_station() — 0044's function, plus the gauge-zero check ──────────
-- Word for word as 0044 left it but for one block, after the stamp checks and
-- 0039's administrator rules: somebody who is not an administrator may send
-- gauge_survey (the editor sends it whenever the list was touched) only if the
-- rows' dates, gauge zeros and datums come out as the station already has them.
-- Rows are compared as a set, so their order is not a change, and 94.50 is
-- 94.5 (trim_scale).

create or replace function meganet.save_station(
         p_doc jsonb,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       text := p_doc ->> 'id';
  v_actor    text := meganet.actor();
  v_is_new   boolean;
  v_prev     timestamptz;
  v_ord      integer;
  v_rep      jsonb := p_doc -> 'repeater';
  v_delay    integer;
  v_a2       integer;
  v_dup_a2   integer;
  v_sensors  jsonb;
  v_ranges   jsonb;
  v_deleted  timestamptz;
  v_saved    jsonb;
  v_now      timestamptz;
  v_key      text;
  v_bad      text;
  v_proposed boolean;
  v_type     text;
  v_year     integer;
  v_tower    numeric;
  v_from     text;
  v_facing   numeric;
  v_was      boolean;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write to the station list'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see #B8';
  end if;

  if v_id is null or v_id = '' then
    raise exception 'the station has no id' using errcode = '22023';
  end if;
  if coalesce(p_doc ->> 'name', '') = '' then
    raise exception 'a station needs a name' using errcode = '22023';
  end if;
  if jsonb_typeof(p_doc -> 'roles') is distinct from 'array' then
    raise exception 'roles must be an array' using errcode = '22023';
  end if;
  -- Checked here rather than left to the foreign key so a stale pick-list gets
  -- an answer about the form, not about a constraint name.
  if nullif(p_doc ->> 'inspection_config_key', '') is not null
     and not exists (select 1 from meganet.inspection_config c
                      where c.key = p_doc ->> 'inspection_config_key') then
    raise exception 'unknown inspection configuration "%"', p_doc ->> 'inspection_config_key'
      using errcode = '22023',
            hint    = 'the telemetry-type list comes from meganet.inspection_config — reload and pick again';
  end if;
  -- Same manners for the repeater delay: the check constraint would refuse it
  -- anyway, but with a constraint name rather than a sentence.
  if v_rep is not null and jsonb_typeof(v_rep) = 'object' then
    v_delay := (v_rep ->> 'delay_ms')::integer;
    if v_delay is not null and (v_delay < 0 or v_delay > 999) then
      raise exception 'repeater delay must be between 0 and 999 ms, not %', v_delay
        using errcode = '22023';
    end if;
  end if;

  -- And for the ALERT2 address, which has two ways of being wrong that the
  -- indexes would otherwise report by name: out of range, and already somebody
  -- else's. The second is the one worth a sentence — the person typing it has no
  -- other way to find out who holds it.
  v_a2 := nullif(p_doc ->> 'alert2_station_id', '')::integer;
  if v_a2 is not null and (v_a2 < 1 or v_a2 > 65535) then
    raise exception 'an ALERT2 station address is 1-65535, not %', v_a2
      using errcode = '22023';
  end if;
  if v_a2 is not null and exists (
       select 1 from meganet.station st
        where st.alert2_station_id = v_a2 and st.deleted_at is null and st.id <> v_id) then
    raise exception 'ALERT2 station address % already belongs to another station', v_a2
      using errcode = '22023',
            hint    = 'two stations on one address would resolve to neither — clear it there first';
  end if;

  -- Two sensor rows claiming one slot is the same ambiguity one level down.
  select (x.value ->> 'alert2_sensor_id')::integer into v_dup_a2
    from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb)) x
   where nullif(x.value ->> 'alert2_sensor_id', '') is not null
   group by (x.value ->> 'alert2_sensor_id')::integer
  having count(*) > 1
   limit 1;
  if v_dup_a2 is not null then
    raise exception 'two sensors are both ALERT2 slot % — a slot is one instrument', v_dup_a2
      using errcode = '22023';
  end if;

  -- The lists 0031 and 0032 added. Each is a list when it is there at all, and
  -- the codes in it are ones the vocabularies know — asked here, before anything
  -- is written, so a code nobody knows gets a sentence naming it rather than a
  -- foreign key's name.
  foreach v_key in array array['flood_classes', 'crossings', 'gauge_survey',
                               'bureau_listings', 'flood_effects',
                               'aep_levels', 'frequencies'] loop
    if p_doc ? v_key and jsonb_typeof(p_doc -> v_key) is distinct from 'array' then
      raise exception '% must be a list', v_key using errcode = '22023';
    end if;
  end loop;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'crossing_type'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'flood_classes') = 'array'
                                           then p_doc -> 'flood_classes' else '[]'::jsonb end) x
          union all
          select nullif(btrim(x.value ->> 'crossing_type'), '')
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'crossings') = 'array'
                                           then p_doc -> 'crossings' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.crossing_type t where t.code = c.code);
  if v_bad is not null then
    raise exception 'unknown crossing type %', v_bad
      using errcode = '22023',
            hint    = 'the crossing types are the Bureau''s legend, in meganet.crossing_type';
  end if;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'datum'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'gauge_survey') = 'array'
                                           then p_doc -> 'gauge_survey' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.gauge_datum d where d.code = c.code);
  if v_bad is not null then
    raise exception 'unknown datum %', v_bad
      using errcode = '22023',
            hint    = 'the datums a gauge zero may be in are meganet.gauge_datum';
  end if;

  -- The two lists 0033 added, asked the same way: a sentence naming what is
  -- wrong rather than a check constraint's name. The editor offers only the
  -- values these accept, so a refusal here is a stale tab or a hand-made
  -- document.
  select string_agg(distinct msg, '; ') into v_bad
    from (select case
                   when nullif(btrim(x.value ->> 'setting'), '') is not null
                    and btrim(x.value ->> 'setting') not in ('channel', 'floodplain')
                     then format('setting %L is neither channel nor floodplain', x.value ->> 'setting')
                   when nullif(x.value ->> 'data_quality', '')::numeric not between 1 and 3
                     then format('data quality %s is not 1–3', x.value ->> 'data_quality')
                   when nullif(x.value ->> 'level_difference', '')::numeric not between 1 and 3
                     then format('level difference %s is not 1–3', x.value ->> 'level_difference')
                   when nullif(x.value ->> 'confidence', '')::numeric not between 1 and 9
                     then format('confidence %s is not 1–9', x.value ->> 'confidence')
                   when nullif(x.value ->> 'slope', '')::numeric < 0
                     then format('slope %s is below zero', x.value ->> 'slope')
                   when nullif(x.value ->> 'manning_n', '')::numeric not between 0.01 and 0.3
                     then format('Manning n %s is outside 0.01–0.3', x.value ->> 'manning_n')
                 end as msg
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'aep_levels') = 'array'
                                           then p_doc -> 'aep_levels' else '[]'::jsonb end) x
          union all
          select case
                   when nullif(x.value ->> 'rx_mhz', '')::numeric <= 0
                     or nullif(x.value ->> 'tx_mhz', '')::numeric <= 0
                     then 'a frequency is a positive number of MHz'
                 end
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'frequencies') = 'array'
                                           then p_doc -> 'frequencies' else '[]'::jsonb end) x) c
   where msg is not null;
  if v_bad is not null then
    raise exception 'not saved: %', v_bad using errcode = '22023';
  end if;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'section'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'bureau_listings') = 'array'
                                           then p_doc -> 'bureau_listings' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.bureau_index b where b.code = c.code);
  if v_bad is not null then
    raise exception 'unknown Bureau index section %', v_bad
      using errcode = '22023',
            hint    = 'the indexes a station can be listed in are meganet.bureau_index — Sections 1, 2 and 3';
  end if;
  -- A listing that says something, but not which index: refused rather than
  -- dropped, because somebody typed the date or the note meaning to keep it.
  if exists (select 1
               from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'bureau_listings') = 'array'
                                              then p_doc -> 'bureau_listings' else '[]'::jsonb end) x
              where nullif(btrim(x.value ->> 'section'), '') is null
                and num_nonnulls(nullif(x.value ->> 'as_at', ''),
                                 nullif(btrim(x.value ->> 'note'), '')) > 0) then
    raise exception 'a Bureau index listing needs the section it is listed in'
      using errcode = '22023',
            hint    = 'pick Section 1, 2 or 3 for the row, or remove it';
  end if;

  -- The tower's platform height (0040): one of the standard drawing's two,
  -- 3.0 m or 4.5 m, or absent. Asked before anything is written, in a sentence
  -- rather than the column's check.
  if jsonb_typeof(p_doc -> 'tower_height') not in ('number', 'string', 'null') then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not %', p_doc -> 'tower_height'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_doc ->> 'tower_height'), '') is not null
     and btrim(p_doc ->> 'tower_height') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not "%"', p_doc ->> 'tower_height'
      using errcode = '22023';
  end if;
  v_tower := nullif(btrim(p_doc ->> 'tower_height'), '')::numeric;
  if v_tower is not null and v_tower not in (3.0, 4.5) then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not %', v_tower
      using errcode = '22023',
            hint    = 'the standard drawing''s two platform heights, each on a 2100 × 2100 footing';
  end if;

  -- The station it takes its flood history from (0041): another live station,
  -- or absent.
  if jsonb_typeof(p_doc -> 'flood_peaks_from') not in ('string', 'null') then
    raise exception 'flood_peaks_from is a station''s id, not %', p_doc -> 'flood_peaks_from'
      using errcode = '22023';
  end if;
  v_from := nullif(btrim(p_doc ->> 'flood_peaks_from'), '');
  if v_from is not null and v_from = v_id then
    raise exception 'a station cannot take its flood history from itself'
      using errcode = '22023';
  end if;
  if v_from is not null
     and not exists (select 1 from meganet.station s where s.id = v_from and s.deleted_at is null) then
    raise exception 'there is no station "%" to take the flood history from', v_from
      using errcode = '22023',
            hint    = 'name it by its id, such as gatton';
  end if;

  -- The way the station faces (0044): a bearing in whole or part degrees,
  -- 0 up to but not 360, or absent. 360 is read as 0 rather than refused.
  if jsonb_typeof(p_doc -> 'facing_deg') not in ('number', 'string', 'null') then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not %', p_doc -> 'facing_deg'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_doc ->> 'facing_deg'), '') is not null
     and btrim(p_doc ->> 'facing_deg') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not "%"', p_doc ->> 'facing_deg'
      using errcode = '22023';
  end if;
  v_facing := round(nullif(btrim(p_doc ->> 'facing_deg'), '')::numeric, 1);
  if v_facing = 360 then v_facing := 0; end if;
  if v_facing is not null and (v_facing < 0 or v_facing >= 360) then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not %', v_facing
      using errcode = '22023',
            hint    = 'clockwise from true north: 0 north, 90 east, 180 south, 270 west';
  end if;

  -- The proposal (0039), asked before anything is written, like the lists
  -- above: `proposed` is true or false when it is there at all, the type is one
  -- meganet.station_type knows, and the year is four figures a person could
  -- mean. A proposal carries all three things that make it one — what kind of
  -- station, the year it is proposed for, and where it would go — and each
  -- missing one is refused with its own sentence rather than the constraint's.
  if jsonb_typeof(p_doc -> 'proposed') not in ('boolean', 'null') then
    raise exception 'proposed is true or false, not %', p_doc -> 'proposed'
      using errcode = '22023';
  end if;
  v_proposed := coalesce((p_doc ->> 'proposed')::boolean, false);
  v_type := nullif(btrim(p_doc ->> 'station_type'), '');
  if v_type is not null
     and not exists (select 1 from meganet.station_type t where t.code = v_type) then
    raise exception 'unknown station type "%"', v_type
      using errcode = '22023',
            hint    = 'the types are meganet.station_type: an automatic or manual water level station, an automatic or manual rain gauge';
  end if;
  if nullif(btrim(p_doc ->> 'proposed_year'), '') is not null
     and btrim(p_doc ->> 'proposed_year') !~ '^[0-9]{4}$' then
    raise exception 'the year a station is proposed for is a year, such as 2026 — not "%"', p_doc ->> 'proposed_year'
      using errcode = '22023';
  end if;
  v_year := nullif(btrim(p_doc ->> 'proposed_year'), '')::integer;
  if v_year is not null and (v_year < 1900 or v_year > 2200) then
    raise exception 'the year a station is proposed for is between 1900 and 2200, not %', v_year
      using errcode = '22023';
  end if;
  if v_proposed then
    if v_type is null then
      raise exception 'a proposed station needs its type: an automatic or manual water level station, or an automatic or manual rain gauge'
        using errcode = '22023';
    end if;
    if v_year is null then
      raise exception 'a proposed station needs the year it is proposed for'
        using errcode = '22023';
    end if;
    if nullif(p_doc ->> 'lat', '') is null or nullif(p_doc ->> 'lon', '') is null then
      raise exception 'a proposed station needs a position: where it is proposed to go'
        using errcode = '22023',
              hint    = 'type its latitude and longitude, or pick the point on the map with What is here';
    end if;
  end if;

  -- Lock the row before reading its stamp, so the check below and the write
  -- after it see the same version. Without the lock two saves can both read the
  -- stamp they expect and both proceed.
  select updated_at, deleted_at, proposed into v_prev, v_deleted, v_was
    from meganet.station where id = v_id for update;
  v_is_new := not found;

  if v_is_new then
    if p_expected_updated_at is not null then
      raise exception 'station "%" is no longer in the database — it was deleted while you had it open', v_id
        using errcode = 'PT409',
              hint    = 'your edits are still on screen; copy anything you need, then reload';
    end if;
  else
    if p_expected_updated_at is null then
      raise exception 'this editor did not load station "%" from the database, so it will not overwrite it', v_id
        using errcode = 'PT409',
              hint    = 'reload from the datastore and open the station again';
    end if;
    if v_prev is distinct from p_expected_updated_at then
      raise exception 'station "%" was changed in the database at %, after you opened it', v_id, v_prev
        using errcode = 'PT409',
              hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
    end if;
  end if;

  -- Who may add a station, and who may establish one (0039). A new station
  -- that is not a proposal is a station added outright; a flag that changes on
  -- a station already here is a proposal established, or an established
  -- station taken back to proposed. All three are an administrator's
  -- (is_admin(), 0036, which says yes to the service role and to a direct
  -- connection). Anybody who may edit may propose one and edit a proposal.
  -- After the stamp checks, so a stale tab hears that first. The detail line is
  -- what tells this refusal from 42501's other meaning, "not on the editors
  -- list", which asks for something different of the person reading it.
  if not meganet.is_admin() then
    if v_is_new and not v_proposed then
      raise exception 'only an administrator adds a station outright — save it as a proposed station, and an administrator establishes it'
        using errcode = '42501',
              detail  = 'administrator',
              hint    = 'tick Proposed, give it a type and a year, and save again';
    end if;
    if not v_is_new and v_was is distinct from v_proposed then
      raise exception '%', case when v_was
                                then 'only an administrator establishes a proposed station'
                                else 'only an administrator takes an established station back to proposed' end
        using errcode = '42501',
              detail  = 'administrator';
    end if;
  end if;

  -- Gauge zero is an administrator's (0060). The rows' dates, gauge zeros and
  -- datums, as a set, must come out as the station has them; the AMTD, the
  -- catchment area and the note are anybody's who may edit. Rows with neither
  -- a gauge zero nor a datum say nothing about a level and are left out of it.
  if p_doc ? 'gauge_survey' and not meganet.is_admin() then
    if coalesce((select pg_catalog.string_agg(pg_catalog.format('%s|%s|%s|%s', g.valid_from, g.valid_to,
                                                                pg_catalog.trim_scale(g.gauge_zero_m), g.datum), ';'
                                              order by g.valid_from nulls first, g.valid_to nulls first,
                                                       g.gauge_zero_m nulls first, g.datum nulls first)
                   from meganet.station_gauge_survey g
                  where g.station_id = v_id and (g.gauge_zero_m is not null or g.datum is not null)), '')
       is distinct from
       coalesce((select pg_catalog.string_agg(pg_catalog.format('%s|%s|%s|%s', r.valid_from, r.valid_to,
                                                                pg_catalog.trim_scale(r.gauge_zero_m), r.datum), ';'
                                              order by r.valid_from nulls first, r.valid_to nulls first,
                                                       r.gauge_zero_m nulls first, r.datum nulls first)
                   from (select nullif(x.value ->> 'valid_from', '')::date              as valid_from,
                                nullif(x.value ->> 'valid_to', '')::date                as valid_to,
                                nullif(x.value ->> 'gauge_zero_m', '')::numeric         as gauge_zero_m,
                                nullif(pg_catalog.btrim(x.value ->> 'datum'), '')       as datum
                           from pg_catalog.jsonb_array_elements(p_doc -> 'gauge_survey') x(value)) r
                  where r.gauge_zero_m is not null or r.datum is not null), '') then
      raise exception 'only an administrator changes a station''s gauge zero, its datum or the dates it applies between'
        using errcode = '42501',
              detail  = 'administrator',
              hint    = 'record it in a level survey on the Level Survey tab, and an administrator applies it — the AMTD, catchment area and notes are still yours to edit';
    end if;
  end if;

  -- Position in the document. An existing station keeps its place; a new one
  -- goes on the end, which is where an appended station lands in the file too.
  if v_is_new then
    select coalesce(max(ord), -1) + 1 into v_ord from meganet.station;
  else
    select ord into v_ord from meganet.station where id = v_id;
  end if;

  insert into meganet.station (
    id, ord, name, station_number, lat, lon, elevation_ahd, elevation_source, owner,
    roles, radio_network_ids, catchment_ids, alert_ids, satcom,
    rm_system_id, enabled, notes, legacy_unit_id, site, lga, basin,
    location_types, tbrg_bucket_size, inspection_config_key,
    alert2_station_id, awrc_number, stream, urbs_label, proposed, station_type,
    proposed_year, tower_height, flood_peaks_from, facing_deg, deleted_at, updated_by)
  values (
    v_id, v_ord,
    p_doc ->> 'name',
    coalesce(p_doc ->> 'station_number', ''),
    (p_doc ->> 'lat')::numeric,
    (p_doc ->> 'lon')::numeric,
    (p_doc ->> 'elevation_ahd')::numeric,
    p_doc ->> 'elevation_source',
    nullif(btrim(p_doc ->> 'owner'), ''),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'roles') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'radio_network_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'catchment_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce(p_doc -> 'alert_ids', '{}'::jsonb),
    coalesce(p_doc -> 'satcom', '{}'::jsonb),
    -- Not coalesced to 1 any more. 0022 made this column nullable because the
    -- bench gateway has no radio system and meganet.rm_system is empty until
    -- load_stations_doc() fills it — but save_station() went on defaulting a
    -- missing value to 1, which fails the foreign key outright on a database
    -- built from zero and, on a database that has rm_system 1, quietly writes it
    -- over the null 0022 had just made legal. Half of that fix was missing.
    nullif(p_doc ->> 'rm_system_id', '')::integer,
    coalesce((p_doc ->> 'enabled')::boolean, true),
    coalesce(p_doc ->> 'notes', ''),
    (p_doc ->> 'legacy_unit_id')::integer,
    p_doc -> 'site',
    p_doc ->> 'lga',
    p_doc ->> 'basin',
    (select array_agg(v order by o)
       from jsonb_array_elements_text(p_doc -> 'location_types') with ordinality t(v, o)),
    (p_doc ->> 'TBRGbucketSize')::numeric,
    nullif(p_doc ->> 'inspection_config_key', ''),
    -- Empty stays null. 0022 made rm_system_id nullable and the form promptly
    -- wrote 1 over every null it found, because `parseInt('') || 1` is 1; this
    -- column gets no such default, here or in the form.
    v_a2,
    -- 0032's three: a blank one is null, so the view's absent-rather-than-null
    -- shape holds whichever way a row arrived.
    nullif(btrim(p_doc ->> 'awrc_number'), ''),
    nullif(btrim(p_doc ->> 'stream'), ''),
    nullif(btrim(p_doc ->> 'urbs_label'), ''),
    -- 0039's three, as asked above.
    v_proposed, v_type, v_year,
    -- 0040's, 0041's and 0044's, as asked above.
    v_tower, v_from, v_facing,
    -- Saving a station that had been deleted brings it back. The alternative is
    -- refusing the save of a station the editor is looking at, which would be a
    -- puzzle rather than a safeguard.
    null,
    v_actor)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon,
         elevation_ahd = excluded.elevation_ahd,
         elevation_source = excluded.elevation_source, owner = excluded.owner,
         roles = excluded.roles,
         radio_network_ids = excluded.radio_network_ids,
         catchment_ids = excluded.catchment_ids, alert_ids = excluded.alert_ids,
         satcom = excluded.satcom, rm_system_id = excluded.rm_system_id,
         enabled = excluded.enabled, notes = excluded.notes,
         legacy_unit_id = excluded.legacy_unit_id, site = excluded.site,
         lga = excluded.lga, basin = excluded.basin,
         location_types = excluded.location_types,
         tbrg_bucket_size = excluded.tbrg_bucket_size,
         inspection_config_key = excluded.inspection_config_key,
         alert2_station_id = excluded.alert2_station_id,
         awrc_number = excluded.awrc_number, stream = excluded.stream,
         urbs_label = excluded.urbs_label,
         proposed = excluded.proposed, station_type = excluded.station_type,
         proposed_year = excluded.proposed_year,
         tower_height = excluded.tower_height,
         flood_peaks_from = excluded.flood_peaks_from,
         facing_deg = excluded.facing_deg,
         deleted_at = null, updated_by = excluded.updated_by;

  -- ── sensors ───────────────────────────────────────────────────────────────
  -- Normalised into a variable first, because the delete and the insert below
  -- both need the same list and a CTE cannot span two statements.
  --
  -- The natural key is (station_id, sensor_id, type), and a row the operator
  -- typed by hand has no sensor_id — those come from ARRO's export. One is
  -- minted from the station and, in order of preference, the ALERT address, the
  -- ALERT2 slot, or the row's position. The order matters: position is the only
  -- one of the three that changes when the form is reordered, so it is the last
  -- resort rather than the second.
  --
  -- `distinct on` because two rows with the same address and type are the same
  -- sensor typed twice, and ON CONFLICT refuses to touch one row twice in a
  -- statement — a duplicate would otherwise fail the whole save with an error
  -- about the query rather than about the form.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sensor_id', sensor_id, 'type', type, 'ord', ord,
           'alert_id', alert_id, 'device_id', device_id,
           'alert2_sensor_id', alert2_sensor_id) order by ord), '[]'::jsonb)
    into v_sensors
    from (
      select distinct on (sensor_id, type) sensor_id, type, ord, alert_id, device_id,
             alert2_sensor_id
        from (
          select coalesce(nullif(x.value ->> 'sensor_id', ''),
                          v_id || ':' || coalesce(
                            x.value ->> 'alert_id',
                            case when nullif(x.value ->> 'alert2_sensor_id', '') is not null
                                 then 'a2:' || (x.value ->> 'alert2_sensor_id') end,
                            (x.ord - 1)::text))                                       as sensor_id,
                 coalesce(nullif(x.value ->> 'type', ''), 'Unknown')                  as type,
                 (x.ord - 1)::integer                                                 as ord,
                 (x.value ->> 'alert_id')::integer                                    as alert_id,
                 (x.value ->> 'device_id')::integer                                   as device_id,
                 nullif(x.value ->> 'alert2_sensor_id', '')::integer                  as alert2_sensor_id
            from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb))
                 with ordinality x(value, ord)
        ) raw
       order by sensor_id, type, ord
    ) uniq;

  delete from meganet.sensor t
   where t.station_id = v_id
     and not exists (select 1 from jsonb_array_elements(v_sensors) e
                      where e.value ->> 'sensor_id' = t.sensor_id
                        and e.value ->> 'type'      = t.type);

  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, device_id,
                              alert2_sensor_id, updated_by)
  select v_id, e.value ->> 'sensor_id', e.value ->> 'type', (e.value ->> 'ord')::integer,
         (e.value ->> 'alert_id')::integer, (e.value ->> 'device_id')::integer,
         (e.value ->> 'alert2_sensor_id')::integer, v_actor
    from jsonb_array_elements(v_sensors) e
  on conflict (station_id, sensor_id, type) do update
     set ord = excluded.ord, alert_id = excluded.alert_id,
         device_id = excluded.device_id,
         alert2_sensor_id = excluded.alert2_sensor_id,
         updated_by = excluded.updated_by
   where (meganet.sensor.ord, meganet.sensor.alert_id, meganet.sensor.device_id,
          meganet.sensor.alert2_sensor_id)
      is distinct from (excluded.ord, excluded.alert_id, excluded.device_id,
                        excluded.alert2_sensor_id);

  -- ── repeater and its ranges ───────────────────────────────────────────────
  -- The role is what decides, not the presence of the object: un-ticking
  -- "repeater" in the editor has to remove the repeater detail, or a station
  -- keeps passing addresses it is no longer a repeater for.
  if v_rep is null or jsonb_typeof(v_rep) is distinct from 'object'
     or not (coalesce(p_doc -> 'roles', '[]'::jsonb) ? 'repeater') then
    -- Cascades to pass_range.
    delete from meganet.repeater where station_id = v_id;
  else
    insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, delay_ms, notes, updated_by)
    values (v_id, coalesce(v_rep ->> 'acma_licence', ''),
            (v_rep ->> 'rx_mhz')::numeric, (v_rep ->> 'tx_mhz')::numeric,
            v_delay,
            coalesce(v_rep ->> 'notes', ''), v_actor)
    on conflict (station_id) do update
       set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
           tx_mhz = excluded.tx_mhz, delay_ms = excluded.delay_ms,
           notes = excluded.notes, updated_by = excluded.updated_by;

    -- Ranges are replaced wholesale rather than diffed. There are ten of them on
    -- a busy repeater, they have no identity beyond their own numbers, and the
    -- editor hands over a textarea — "these are the ranges now" is what it means
    -- and what this does. Duplicated lines collapse: (kind, lo, hi) is the key.
    select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'lo', lo, 'hi', hi, 'ord', ord)
                              order by ord), '[]'::jsonb)
      into v_ranges
      from (
        select distinct on (kind, lo, hi) kind, lo, hi, ord
          from (
            select k.kind,
                   (p.value ->> 'low')::integer  as lo,
                   (p.value ->> 'high')::integer as hi,
                   (p.ord - 1)::integer          as ord
              from (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions')) as k(kind, field)
              cross join lateral jsonb_array_elements(coalesce(v_rep -> k.field, '[]'::jsonb))
                         with ordinality p(value, ord)
             where (p.value ->> 'low') is not null and (p.value ->> 'high') is not null
          ) raw
         order by kind, lo, hi, ord
      ) uniq;

    delete from meganet.pass_range where repeater_id = v_id;

    insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by)
    select v_id, e.value ->> 'kind', (e.value ->> 'lo')::integer,
           (e.value ->> 'hi')::integer, (e.value ->> 'ord')::integer, v_actor
      from jsonb_array_elements(v_ranges) e;
  end if;

  -- ── flood classes, crossings, gauge survey (0031) ─────────────────────────
  -- Each list the editor sends is "these are the rows now", so it replaces what
  -- is there, the way the pass ranges above are replaced. A list that is not in
  -- the document at all is left exactly as it is — see the head of 0031 for why
  -- that differs from the sensors. Blank rows are dropped rather than refused: an
  -- editor's "+ Add" row left empty is not something anybody meant to save. What
  -- survives is renumbered from 0, so `ord` stays the list's own order.
  if p_doc ? 'flood_classes' then
    delete from meganet.station_flood_class where station_id = v_id;
    insert into meganet.station_flood_class (
      station_id, ord, as_at, first_report_m, crossing_height_m, crossing_type,
      minor_m, crops_grazing_m, moderate_m, towns_m, major_m, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.first_report_m, r.crossing_height_m, r.crossing_type,
           r.minor_m, r.crops_grazing_m, r.moderate_m, r.towns_m, r.major_m, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                   as as_at,
               nullif(x.value ->> 'first_report_m', '')::numeric       as first_report_m,
               nullif(x.value ->> 'crossing_height_m', '')::numeric    as crossing_height_m,
               nullif(btrim(x.value ->> 'crossing_type'), '')          as crossing_type,
               nullif(x.value ->> 'minor_m', '')::numeric              as minor_m,
               nullif(x.value ->> 'crops_grazing_m', '')::numeric      as crops_grazing_m,
               nullif(x.value ->> 'moderate_m', '')::numeric           as moderate_m,
               nullif(x.value ->> 'towns_m', '')::numeric              as towns_m,
               nullif(x.value ->> 'major_m', '')::numeric              as major_m,
               nullif(btrim(x.value ->> 'note'), '')                   as note
          from jsonb_array_elements(p_doc -> 'flood_classes') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.first_report_m, r.crossing_height_m, r.crossing_type, r.minor_m,
                        r.crops_grazing_m, r.moderate_m, r.towns_m, r.major_m, r.note) > 0;
  end if;

  if p_doc ? 'crossings' then
    delete from meganet.station_crossing where station_id = v_id;
    insert into meganet.station_crossing (
      station_id, ord, as_at, stream, name, height_m, crossing_type, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.stream, r.name, r.height_m, r.crossing_type, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                as as_at,
               nullif(btrim(x.value ->> 'stream'), '')              as stream,
               nullif(btrim(x.value ->> 'name'), '')                as name,
               nullif(x.value ->> 'height_m', '')::numeric          as height_m,
               nullif(btrim(x.value ->> 'crossing_type'), '')       as crossing_type,
               nullif(btrim(x.value ->> 'note'), '')                as note
          from jsonb_array_elements(p_doc -> 'crossings') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.stream, r.name, r.height_m, r.crossing_type, r.note) > 0;
  end if;

  if p_doc ? 'gauge_survey' then
    delete from meganet.station_gauge_survey where station_id = v_id;
    insert into meganet.station_gauge_survey (
      station_id, ord, valid_from, valid_to, gauge_zero_m, datum, amtd_km,
      catchment_area_km2, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.valid_from, r.valid_to, r.gauge_zero_m, r.datum, r.amtd_km,
           r.catchment_area_km2, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'valid_from', '')::date                as valid_from,
               nullif(x.value ->> 'valid_to', '')::date                  as valid_to,
               nullif(x.value ->> 'gauge_zero_m', '')::numeric           as gauge_zero_m,
               nullif(btrim(x.value ->> 'datum'), '')                    as datum,
               nullif(x.value ->> 'amtd_km', '')::numeric                as amtd_km,
               nullif(x.value ->> 'catchment_area_km2', '')::numeric     as catchment_area_km2,
               nullif(btrim(x.value ->> 'note'), '')                     as note
          from jsonb_array_elements(p_doc -> 'gauge_survey') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.gauge_zero_m, r.datum, r.amtd_km, r.catchment_area_km2, r.note) > 0;
  end if;

  -- ── index listings, flood effects (0032) ─────────────────────────────────
  -- 0031's rule for 0031's lists: present replaces, absent leaves alone, blank
  -- rows go, and what is left is renumbered from 0.
  if p_doc ? 'bureau_listings' then
    delete from meganet.station_bureau_listing where station_id = v_id;
    insert into meganet.station_bureau_listing (
      station_id, ord, section, as_at, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.section, r.as_at, r.note, v_actor
      from (
        select x.ord,
               nullif(btrim(x.value ->> 'section'), '')        as section,
               nullif(x.value ->> 'as_at', '')::date           as as_at,
               nullif(btrim(x.value ->> 'note'), '')           as note
          from jsonb_array_elements(p_doc -> 'bureau_listings') with ordinality x(value, ord)
      ) r
     where r.section is not null;
  end if;

  if p_doc ? 'flood_effects' then
    delete from meganet.station_flood_effect where station_id = v_id;
    insert into meganet.station_flood_effect (
      station_id, ord, as_at, height_m, effect, detail, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.height_m, r.effect, r.detail, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date           as as_at,
               nullif(x.value ->> 'height_m', '')::numeric     as height_m,
               nullif(btrim(x.value ->> 'effect'), '')         as effect,
               nullif(btrim(x.value ->> 'detail'), '')         as detail,
               nullif(btrim(x.value ->> 'note'), '')           as note
          from jsonb_array_elements(p_doc -> 'flood_effects') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.height_m, r.effect, r.detail, r.note) > 0;
  end if;

  -- ── AEP levels, frequencies (0033) ────────────────────────────────────────
  -- 0031's rule: the list the editor sends replaces what is there, a list it
  -- does not send is left alone, and a blank row is dropped.
  if p_doc ? 'aep_levels' then
    delete from meganet.station_aep_level where station_id = v_id;
    insert into meganet.station_aep_level (
      station_id, ord, as_at, source, point_lat, point_lon, ground_m, aep_1_m,
      aep_0_5_m, aep_0_2_m, aep_0_066_m, data_quality, level_difference, confidence,
      setting, slope, slope_basis, manning_n, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.source, r.point_lat, r.point_lon, r.ground_m, r.aep_1_m,
           r.aep_0_5_m, r.aep_0_2_m, r.aep_0_066_m, r.data_quality, r.level_difference,
           r.confidence, r.setting, r.slope, r.slope_basis, r.manning_n, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                as as_at,
               nullif(btrim(x.value ->> 'source'), '')              as source,
               nullif(x.value ->> 'point_lat', '')::numeric         as point_lat,
               nullif(x.value ->> 'point_lon', '')::numeric         as point_lon,
               nullif(x.value ->> 'ground_m', '')::numeric          as ground_m,
               nullif(x.value ->> 'aep_1_m', '')::numeric           as aep_1_m,
               nullif(x.value ->> 'aep_0_5_m', '')::numeric         as aep_0_5_m,
               nullif(x.value ->> 'aep_0_2_m', '')::numeric         as aep_0_2_m,
               nullif(x.value ->> 'aep_0_066_m', '')::numeric       as aep_0_066_m,
               nullif(x.value ->> 'data_quality', '')::integer      as data_quality,
               nullif(x.value ->> 'level_difference', '')::integer  as level_difference,
               nullif(x.value ->> 'confidence', '')::integer        as confidence,
               nullif(btrim(x.value ->> 'setting'), '')             as setting,
               nullif(x.value ->> 'slope', '')::numeric             as slope,
               nullif(btrim(x.value ->> 'slope_basis'), '')         as slope_basis,
               nullif(x.value ->> 'manning_n', '')::numeric         as manning_n,
               nullif(btrim(x.value ->> 'note'), '')                as note
          from jsonb_array_elements(p_doc -> 'aep_levels') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.ground_m, r.aep_1_m, r.aep_0_5_m, r.aep_0_2_m, r.aep_0_066_m,
                        r.setting, r.slope, r.manning_n, r.note) > 0;
  end if;

  if p_doc ? 'frequencies' then
    delete from meganet.station_frequency where station_id = v_id;
    insert into meganet.station_frequency (
      station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.rx_mhz, r.tx_mhz, r.label, r.acma_licence, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'rx_mhz', '')::numeric        as rx_mhz,
               nullif(x.value ->> 'tx_mhz', '')::numeric        as tx_mhz,
               nullif(btrim(x.value ->> 'label'), '')           as label,
               nullif(btrim(x.value ->> 'acma_licence'), '')    as acma_licence
          from jsonb_array_elements(p_doc -> 'frequencies') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.rx_mhz, r.tx_mhz) > 0;
  end if;

  select updated_at into v_now from meganet.station where id = v_id;
  select doc into v_saved from meganet.station_json where id = v_id;

  return jsonb_build_object(
           'station',    v_saved,
           'updated_at', v_now,
           'created',    v_is_new,
           'updated_by', v_actor);

exception
  -- Two saves racing to create the same id: the loser's insert hits the primary
  -- key rather than the stamp check above, because there was no row to lock.
  -- Same situation, so it gets the same answer.
  when unique_violation then
    raise exception 'station "%" already exists — somebody created it while you were typing', v_id
      using errcode = 'PT409',
            hint    = 'your edits are still on screen; give the station another name or reload';
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────

revoke all on function meganet.level_num(jsonb)                          from public;
revoke all on function meganet.level_equipment_save(jsonb)               from public;
revoke all on function meganet.two_peg_test_save(jsonb)                  from public;
revoke all on function meganet.level_survey_save(jsonb)                  from public;
revoke all on function meganet.level_evidence_add(jsonb)                 from public;
revoke all on function meganet.level_survey_apply(uuid, jsonb, text)     from public;
revoke all on function meganet.level_survey_return(uuid, text)           from public;
revoke all on function meganet.save_station(jsonb, timestamptz)          from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke insert, update, delete, truncate
    on meganet.level_equipment, meganet.two_peg_test, meganet.level_survey, meganet.level_evidence,
       meganet.station_level_point, meganet.station_level_offset, meganet.level_survey_decision
    from anon, authenticated;
  grant select
    on meganet.level_equipment, meganet.two_peg_test, meganet.level_survey, meganet.level_evidence,
       meganet.station_level_point, meganet.station_level_offset, meganet.level_survey_decision
    to authenticated, service_role;
  grant execute on function meganet.level_equipment_save(jsonb)           to authenticated, service_role;
  grant execute on function meganet.two_peg_test_save(jsonb)              to authenticated, service_role;
  grant execute on function meganet.level_survey_save(jsonb)              to authenticated, service_role;
  grant execute on function meganet.level_evidence_add(jsonb)             to authenticated, service_role;
  grant execute on function meganet.level_survey_apply(uuid, jsonb, text) to authenticated, service_role;
  grant execute on function meganet.level_survey_return(uuid, text)       to authenticated, service_role;
  grant execute on function meganet.save_station(jsonb, timestamptz)      to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['level_equipment', 'two_peg_test', 'level_survey', 'level_evidence',
                           'station_level_point', 'station_level_offset', 'level_survey_decision'] loop
    if pg_catalog.to_regclass('meganet.' || t) is null then
      raise exception '0060 did not take: meganet.% is missing', t;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('meganet.' || t)) then
      raise exception '0060 did not take: RLS is off on meganet.%', t;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
      if pg_catalog.has_table_privilege('anon', 'meganet.' || t, 'select')
         or pg_catalog.has_table_privilege('anon', 'meganet.' || t, 'insert,update,delete')
         or pg_catalog.has_table_privilege('authenticated', 'meganet.' || t, 'insert,update,delete') then
        raise exception '0060 did not take: a browser role can write meganet.%, or anon can read it', t;
      end if;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'meganet' and p.proname = 'save_station'
                    and pg_catalog.pg_get_functiondef(p.oid) like '%only an administrator changes a station%gauge zero, its datum%') then
    raise exception '0060 did not take: save_station() does not keep gauge zero for administrators';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live, as for 0053–0059. The
-- guard means applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '60')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
