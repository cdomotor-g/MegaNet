-- 0089_station_lpu.sql — What a station's logger is and what it runs: its LPU
-- type, picked from a list that grows only when somebody means it to, its
-- serial number, and the versions that matter for that kind of unit — an ELPRO
-- ERT-A2's firmware, bootloader and radio firmware, a Campbell logger's OS and
-- program. And what the photo reader has read off the field photos, so each
-- photo is read once and what it showed is filled in where nobody has.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0089_station_lpu.sql
--
-- Why this file exists
-- ────────────────────
-- Which logger is at a site, and what firmware it runs, decides what a crew
-- takes there — the cable, the laptop's software, the firmware pack — and which
-- sites a firmware release has still to reach. None of it was recorded
-- anywhere a person could look it up: the inspection sheets' Serial Numbers
-- panel has a line for an ERT A2's "F/W build #", and a photo of a laptop
-- plugged into one often shows its version screen, and that is all.
--
--   1. lpu_type            the kinds of logger (LPU) there are — ELPRO's ERT-A2,
--                          Campbell Scientific's CR300 family and their larger
--                          loggers — each with the family that says which
--                          version fields it has. Public, as every vocabulary is.
--   2. lpu_match_key()     how two spellings of one type are found to be one:
--                          upper case, the make's name taken out, letters and
--                          digits only. `CR 300`, `cr-300` and `Campbell
--                          Scientific CR300` are all CR300; the list holds each
--                          once (a unique index over it), so the same logger
--                          cannot be entered twice under two spellings.
--   3. station_lpu         one row per station: its type, its serial number and
--                          the six version fields, and where each value came
--                          from — a person, or a photo the reader read — so a
--                          value nobody has checked says so.
--   4. station_lpu_change  every change to it: when, who, what it was and what
--                          it became, and the photo when a photo was the reason.
--   5. save_station_lpu()  the door for people. Editors. A stale write is
--                          refused (PT409), as everywhere else here, and a new
--                          LPU type is added with the station that first has it,
--                          only when the editor has said it is new.
--   6. photo_reading       what the photo reader made of each photo it read,
--      record_photo_reading()  and the doors it records it by, one at a time or
--      record_photo_readings() a night's at once — the service key or a direct
--      photos_to_read()        connection, never a browser — and the list of
--                          photos it has still to read.
--
-- ── Near misses are the browser's to catch, exact ones the database's ───────
-- The person typing is in the station editor, so that is where "did you mean
-- CR300?" is asked (lpu-types.js): a typed type that is not on the list is
-- checked against it — a character swapped, a letter for a lookalike digit, a
-- digit different — and the editor is shown the near ones before they may add
-- it. `new_lpu_type` has to arrive with `confirm_new: true`, which the editor
-- only sends once that has been asked. What the database refuses is the
-- certain duplicate: a new type whose model has the same match key as one on
-- the list, which is that one (23505, its key as the detail). One digit is
-- sometimes a different logger — a CR310 is not a CR300 — so a near miss is a
-- question for a person, never a refusal.
--
-- ── What the photo reader may write, and what it may not ─────────────────────
-- A reading is a reading — a version read off a laptop's screen in a photo of
-- it — and two rules keep it honest:
--
--   * It fills only what nobody has recorded, and never writes over a value a
--     person entered or checked. Where the record says something else, the
--     reading says so (applied.lpu.differed) and the station editor shows it
--     beside the value, for a person to decide.
--   * A value it filled carries the photo, the reader, when and how sure
--     (`provenance`), and reads as not yet checked until a person says it is
--     right or types another. The one exception to "never writes over": a
--     value only a photo has vouched for, and nobody has checked, gives way to
--     a different reading off a photo taken later — firmware is upgraded, and
--     the later photo is the better evidence of what runs there now.
--
-- Serial numbers of everything else in the photo — radios, modems, regulators,
-- sensors — go to the equipment register's queue (propose_equipment(), 0036),
-- for an administrator, as before: record_photo_reading() hands them on. A key
-- number is refused outright: site codes live only in the inspection records
-- (0064, CLAUDE.md), and a photo of a padlock is not a way round that.
--
-- ── Who may see it ──────────────────────────────────────────────────────────
-- station_lpu is read by members (0062) — the field crews 0064 opened the
-- inspection records to, whose serial numbers it repeats, are the people who
-- need to know which logger they are driving to. Its history and the
-- readings are editors' only, as the station history is (0056). Nothing here
-- is anon's but the list of types, and nothing here is in the agent API.
--
-- Depends on 0004 (is_editor, actor, touch_updated_at), 0035 (field_photo),
-- 0036 (propose_equipment) and 0062 (is_member). tools/check_station_lpu.sql
-- proves it.

-- ── 1. The kinds of logger ───────────────────────────────────────────────────

-- How a type is matched: its make's name out, letters and digits only, upper
-- case. The makes are the two this network fits, as their labels and the
-- inspection sheets write them; a model from another make keeps its make's
-- name in its key, which is harmless — it only has to match itself.
-- lpu-types.js's matchKey() is the same rule, word for word.
create or replace function meganet.lpu_match_key(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(
             pg_catalog.upper(coalesce(p, '')),
             '\m(CAMPBELL(''?S)?(\s*SCI(ENTIFIC)?)?|CSI|ELPRO(\s*TECHNOLOGIES)?|ERRTS)\M', '', 'g'),
           '[^A-Z0-9]', '', 'g');
$$;

comment on function meganet.lpu_match_key(text) is
  'An LPU type as the list compares it (0089): upper case, the make''s name (Campbell Scientific, ELPRO, ERRTS) taken out, letters and digits only. CR 300, cr-300 and Campbell Scientific CR300 are all CR300. lpu-types.js matchKey() is the same rule.';

create table if not exists meganet.lpu_type (
  key       text        primary key,
  label     text        not null,
  make      text        not null default '',
  model     text        not null,
  -- Which version fields the unit has: an ERT-A2's three, a Campbell logger's
  -- two, or firmware and program for anything else. A family is a set of
  -- columns on station_lpu, so a new one is a migration anyway — hence a check
  -- and not a table.
  family    text        not null default 'other',
  ord       integer     not null default 1000,
  note      text        not null default '',
  added_at  timestamptz not null default pg_catalog.now(),

  constraint lpu_type_key    check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  constraint lpu_type_family check (family in ('ert_a2', 'campbell', 'other')),
  constraint lpu_type_label  check (pg_catalog.length(pg_catalog.btrim(label)) between 1 and 80),
  constraint lpu_type_model  check (pg_catalog.length(pg_catalog.btrim(model)) between 1 and 60
                                    and meganet.lpu_match_key(model) <> ''),
  constraint lpu_type_make   check (pg_catalog.length(make) <= 60),
  constraint lpu_type_note   check (pg_catalog.length(note) <= 500)
);

comment on table meganet.lpu_type is
  'The kinds of logger (LPU) a station can have (0089): make, model, the label shown, and the family that says which version fields it has (ert_a2: firmware, bootloader, radio firmware; campbell: OS version, program; other: firmware, program). Public. Grows only through save_station_lpu(), when an editor has confirmed a type is new; one row per match key.';
comment on column meganet.lpu_type.family is
  'ert_a2 — firmware, bootloader and radio firmware, as the ERT-A2''s version screen prints them; campbell — OS version and program; other — firmware and program.';

create unique index if not exists lpu_type_match_idx on meganet.lpu_type (meganet.lpu_match_key(model));

-- What the network fits (photo-equipment.js's dictionary and the inspection
-- sheets): ELPRO's ERT-A2 at the ALERT sites, Campbell Scientific's loggers at
-- the rest. `do nothing` on a re-run: an entry somebody has since reworded
-- keeps its words.
insert into meganet.lpu_type (key, label, make, model, family, ord, note) values
  ('elpro_ert_a2', 'ELPRO ERT-A2', 'ELPRO', 'ERT-A2', 'ert_a2', 10,
   'ELPRO''s ALERT and ALERT2 remote terminal. Its host firmware, its bootloader and its radio''s firmware are each versioned — the 💾 A2 Firmware tab says which are current.'),
  ('campbell_cr300', 'Campbell Scientific CR300', 'Campbell Scientific', 'CR300', 'campbell', 20,
   'Campbell''s small datalogger. A CR310 is the same with Ethernet, and a CR350 is the next model — three different loggers a digit apart.'),
  ('campbell_cr310', 'Campbell Scientific CR310', 'Campbell Scientific', 'CR310', 'campbell', 21, 'A CR300 with an Ethernet port.'),
  ('campbell_cr350', 'Campbell Scientific CR350', 'Campbell Scientific', 'CR350', 'campbell', 22, 'The CR300''s successor.'),
  ('campbell_cr1000', 'Campbell Scientific CR1000', 'Campbell Scientific', 'CR1000', 'campbell', 30, 'Campbell''s larger datalogger, discontinued for the CR1000X.'),
  ('campbell_cr1000x', 'Campbell Scientific CR1000X', 'Campbell Scientific', 'CR1000X', 'campbell', 31, 'The CR1000''s successor — a different logger, not a CR1000 with a letter added.'),
  ('campbell_cr800', 'Campbell Scientific CR800', 'Campbell Scientific', 'CR800', 'campbell', 40, ''),
  ('campbell_cr850', 'Campbell Scientific CR850', 'Campbell Scientific', 'CR850', 'campbell', 41, 'A CR800 with a keypad and display.'),
  ('campbell_cr6', 'Campbell Scientific CR6', 'Campbell Scientific', 'CR6', 'campbell', 50, ''),
  ('campbell_cr3000', 'Campbell Scientific CR3000', 'Campbell Scientific', 'CR3000', 'campbell', 60, ''),
  ('campbell_cr200x', 'Campbell Scientific CR200X', 'Campbell Scientific', 'CR200X', 'campbell', 70, '')
on conflict do nothing;

-- ── 2. A station's logger ────────────────────────────────────────────────────

create table if not exists meganet.station_lpu (
  station_id              text        primary key references meganet.station (id) on delete cascade,
  lpu_type_key            text        references meganet.lpu_type (key),
  serial_no               text        not null default '',
  firmware_version        text        not null default '',
  bootloader_version      text        not null default '',
  radio_firmware_version  text        not null default '',
  os_version              text        not null default '',
  program                 text        not null default '',
  note                    text        not null default '',

  -- Where each value came from, by column — only for the values there are:
  --   a person:  {"from": "person", "by": "…", "at": "…"}
  --   a photo:   {"from": "photo", "by": "agent:photo-reader", "at": "…",
  --               "photo_id": "…", "taken_at": "…", "confidence": 0.9}
  --              and, once a person has said it is right,
  --              "checked_by": "…", "checked_at": "…"
  provenance              jsonb       not null default '{}'::jsonb,

  updated_at              timestamptz not null default pg_catalog.now(),
  updated_by              text,

  constraint station_lpu_lengths    check (pg_catalog.length(serial_no) <= 64
                                           and pg_catalog.length(firmware_version) <= 120
                                           and pg_catalog.length(bootloader_version) <= 120
                                           and pg_catalog.length(radio_firmware_version) <= 120
                                           and pg_catalog.length(os_version) <= 120
                                           and pg_catalog.length(program) <= 120
                                           and pg_catalog.length(note) <= 1000),
  constraint station_lpu_provenance check (pg_catalog.jsonb_typeof(provenance) = 'object')
);

comment on table meganet.station_lpu is
  'A station''s logger (LPU), one row per station (0089): its type (meganet.lpu_type), serial number, firmware, bootloader and radio firmware (an ERT-A2''s), OS version and program (a Campbell logger''s), a note, and where each value came from (provenance). Read by members; written only by save_station_lpu() (editors) and record_photo_reading() (the photo reader).';
comment on column meganet.station_lpu.provenance is
  'Where each value came from, by column: {"from":"person",…} or {"from":"photo","photo_id":…,"by":"agent:…","taken_at":…,"confidence":…}, plus checked_by/checked_at once a person has said a photo''s value is right. A photo''s value with no checked_at has not been checked by anybody.';

drop trigger if exists station_lpu_touch on meganet.station_lpu;
create trigger station_lpu_touch before update on meganet.station_lpu
  for each row execute function meganet.touch_updated_at();

create table if not exists meganet.station_lpu_change (
  id          bigint      generated always as identity primary key,
  station_id  text        not null,
  changed_at  timestamptz not null default pg_catalog.now(),
  changed_by  text        not null,
  -- 'person' through save_station_lpu(), 'photo' through record_photo_reading().
  source      text        not null,
  photo_id    uuid,
  before      jsonb       not null,
  after       jsonb       not null,

  constraint station_lpu_change_source check (source in ('person', 'photo')),
  constraint station_lpu_change_photo  check ((source = 'photo') = (photo_id is not null))
);

comment on table meganet.station_lpu_change is
  'Every change to a station''s logger details (0089): when, who, whether a person or a photo, and the fields that moved as they were and as they became. Editors only. No foreign key on station_id: the log outlives the row.';

create index if not exists station_lpu_change_station_idx
  on meganet.station_lpu_change (station_id, changed_at desc, id desc);

-- ── 3. The door for people ───────────────────────────────────────────────────
--
--   { station_id,
--     lpu_type_key | new_lpu_type: { label, make, model, family, confirm_new: true },
--     serial_no, firmware_version, bootloader_version, radio_firmware_version,
--     os_version, program, note,
--     checked: [fields whose photo-read values the person says are right] }
--
-- A key that is absent is left as it is; a key sent empty clears the value.
-- p_expected is the updated_at the editor read, null when there was no row: a
-- row that has moved since, or one made since, is refused with PT409 and the
-- edit stays on screen. A save that changes nothing writes nothing and keeps
-- the stamp.
create or replace function meganet.save_station_lpu(p jsonb, p_expected timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_fields  constant text[] := array['serial_no', 'firmware_version', 'bootloader_version',
                                     'radio_firmware_version', 'os_version', 'program', 'note'];
  c_limit   constant integer[] := array[64, 120, 120, 120, 120, 120, 1000];
  v_actor   text := meganet.actor();
  v_now     timestamptz := pg_catalog.now();
  v_key     text;
  v_station text;
  v_row     meganet.station_lpu%rowtype;
  v_exists  boolean;
  v_doc     jsonb;
  v_prov    jsonb;
  v_person  jsonb;
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_new     jsonb;
  v_type    meganet.lpu_type%rowtype;
  v_tkey    text;
  v_label   text;
  v_make    text;
  v_model   text;
  v_family  text;
  v_base    text;
  v_n       integer;
  v_added   text;
  v_i       integer;
  v_field   text;
  v_val     text;
  v_old     text;
  v_checked integer := 0;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to change a station''s logger details'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.save_station_lpu() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key <> all (array['station_id', 'lpu_type_key', 'new_lpu_type', 'checked'] || c_fields) then
      raise exception 'meganet.save_station_lpu() does not take %', v_key
        using errcode = '22023',
              hint    = 'station_id, lpu_type_key or new_lpu_type, serial_no, firmware_version, bootloader_version, radio_firmware_version, os_version, program, note and checked are the whole list';
    end if;
  end loop;

  v_station := nullif(pg_catalog.btrim(coalesce(p ->> 'station_id', '')), '');
  if v_station is null then
    raise exception 'say which station''s logger this is (station_id)' using errcode = '22023';
  end if;
  if not exists (select 1 from meganet.station where id = v_station and deleted_at is null) then
    raise exception 'there is no station "%" to record a logger at', v_station using errcode = '23503';
  end if;

  select * into v_row from meganet.station_lpu where station_id = v_station for update;
  v_exists := found;
  if v_exists and p_expected is null then
    raise exception 'somebody recorded this station''s logger at % while you had it open — reload to see it', v_row.updated_at
      using errcode = 'PT409';
  end if;
  if v_exists and v_row.updated_at <> p_expected then
    raise exception 'this station''s logger details were changed at % by %, after you opened them — reload to see what changed',
      v_row.updated_at, coalesce(v_row.updated_by, 'somebody')
      using errcode = 'PT409';
  end if;
  if not v_exists and p_expected is not null then
    raise exception 'this station''s logger details are not in the database any more — reload'
      using errcode = 'PT409';
  end if;

  if v_exists then
    v_doc := pg_catalog.to_jsonb(v_row);
  else
    v_doc := pg_catalog.jsonb_build_object('station_id', v_station, 'lpu_type_key', null, 'serial_no', '',
               'firmware_version', '', 'bootloader_version', '', 'radio_firmware_version', '',
               'os_version', '', 'program', '', 'note', '', 'provenance', '{}'::jsonb);
  end if;
  v_prov   := coalesce(v_doc -> 'provenance', '{}'::jsonb);
  v_person := pg_catalog.jsonb_build_object('from', 'person', 'by', v_actor, 'at', v_now);

  -- The type: one on the list, or a new one the editor has said is new.
  if p ? 'new_lpu_type' and p ? 'lpu_type_key' then
    raise exception 'send lpu_type_key or new_lpu_type, not both' using errcode = '22023';
  end if;
  if p ? 'new_lpu_type' then
    v_new := p -> 'new_lpu_type';
    if pg_catalog.jsonb_typeof(v_new) <> 'object' then
      raise exception 'new_lpu_type is an object: label, make, model, family and confirm_new' using errcode = '22023';
    end if;
    for v_key in select pg_catalog.jsonb_object_keys(v_new) loop
      if v_key not in ('label', 'make', 'model', 'family', 'confirm_new') then
        raise exception 'new_lpu_type does not take %', v_key using errcode = '22023';
      end if;
    end loop;
    if (v_new -> 'confirm_new') is distinct from 'true'::jsonb then
      raise exception 'a new LPU type is added only once the editor has said it is new (confirm_new: true) — the station editor asks, and shows the types it is close to'
        using errcode = '22023';
    end if;
    v_make   := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(v_new ->> 'make', ''), '\s+', ' ', 'g'));
    v_model  := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(v_new ->> 'model', ''), '\s+', ' ', 'g'));
    v_label  := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(v_new ->> 'label', ''), '\s+', ' ', 'g'));
    v_family := coalesce(nullif(v_new ->> 'family', ''), 'other');
    if meganet.lpu_match_key(v_model) = '' then
      raise exception 'a new LPU type needs its model — letters or digits, such as CR300 or ERT-A2' using errcode = '22023';
    end if;
    if v_family not in ('ert_a2', 'campbell', 'other') then
      raise exception 'a type''s family is ert_a2, campbell or other, not %', v_family using errcode = '22023';
    end if;
    if pg_catalog.length(v_model) > 60 or pg_catalog.length(v_make) > 60 or pg_catalog.length(v_label) > 80 then
      raise exception 'a make or model is at most 60 characters and a label 80' using errcode = '22023';
    end if;
    if v_label = '' then
      v_label := pg_catalog.btrim(pg_catalog.concat_ws(' ', nullif(v_make, ''), v_model));
    end if;
    select * into v_type from meganet.lpu_type t where meganet.lpu_match_key(t.model) = meganet.lpu_match_key(v_model);
    if found then
      raise exception '"%" is % — already on the list, so pick it rather than adding it again', v_label, v_type.label
        using errcode = '23505', detail = v_type.key;
    end if;
    v_base := pg_catalog.btrim(pg_catalog.regexp_replace(
                pg_catalog.lower(pg_catalog.concat_ws(' ', nullif(v_make, ''), v_model)), '[^a-z0-9]+', '_', 'g'), '_');
    if v_base !~ '^[a-z][a-z0-9_]' then
      v_base := 'lpu_' || v_base;
    end if;
    v_base := pg_catalog.rtrim(pg_catalog.left(v_base, 50), '_');
    v_tkey := v_base;
    v_n := 1;
    while exists (select 1 from meganet.lpu_type where key = v_tkey) loop
      v_n := v_n + 1;
      v_tkey := v_base || '_' || v_n;
    end loop;
    insert into meganet.lpu_type (key, label, make, model, family, note)
    values (v_tkey, v_label, v_make, v_model, v_family,
            pg_catalog.left(pg_catalog.format('Added by %s with %s on %s.', v_actor, v_station,
                                              pg_catalog.to_char(v_now, 'YYYY-MM-DD')), 500));
    v_added := v_tkey;
  elsif p ? 'lpu_type_key' then
    v_tkey := nullif(pg_catalog.btrim(coalesce(p ->> 'lpu_type_key', '')), '');
    if v_tkey is not null and not exists (select 1 from meganet.lpu_type where key = v_tkey) then
      raise exception '% is not an LPU type on the list', v_tkey
        using errcode = '23503', hint = 'see meganet.lpu_type — or send new_lpu_type to add one';
    end if;
  end if;
  if (p ? 'new_lpu_type' or p ? 'lpu_type_key') and v_tkey is distinct from (v_doc ->> 'lpu_type_key') then
    v_before := v_before || pg_catalog.jsonb_build_object('lpu_type_key', v_doc -> 'lpu_type_key');
    v_after  := v_after  || pg_catalog.jsonb_build_object('lpu_type_key', v_tkey);
    v_doc    := v_doc    || pg_catalog.jsonb_build_object('lpu_type_key', v_tkey);
    v_prov   := case when v_tkey is null then v_prov - 'lpu_type_key'
                     else v_prov || pg_catalog.jsonb_build_object('lpu_type_key', v_person) end;
  end if;

  -- The values. Runs of spaces as one, except in the note, whose lines are kept.
  for v_i in 1 .. pg_catalog.array_length(c_fields, 1) loop
    v_field := c_fields[v_i];
    continue when not p ? v_field;
    if pg_catalog.jsonb_typeof(p -> v_field) not in ('string', 'null') then
      raise exception '% is text', v_field using errcode = '22023';
    end if;
    v_val := coalesce(p ->> v_field, '');
    v_val := case when v_field = 'note' then pg_catalog.btrim(v_val)
                  else pg_catalog.btrim(pg_catalog.regexp_replace(v_val, '\s+', ' ', 'g')) end;
    if pg_catalog.length(v_val) > c_limit[v_i] then
      raise exception '% is at most % characters', pg_catalog.replace(v_field, '_', ' '), c_limit[v_i] using errcode = '22023';
    end if;
    v_old := coalesce(v_doc ->> v_field, '');
    continue when v_val = v_old;
    v_before := v_before || pg_catalog.jsonb_build_object(v_field, v_old);
    v_after  := v_after  || pg_catalog.jsonb_build_object(v_field, v_val);
    v_doc    := v_doc    || pg_catalog.jsonb_build_object(v_field, v_val);
    v_prov   := case when v_val = '' then v_prov - v_field
                     else v_prov || pg_catalog.jsonb_build_object(v_field, v_person) end;
  end loop;

  -- Values a photo filled that the person says are right.
  if p ? 'checked' then
    if pg_catalog.jsonb_typeof(p -> 'checked') <> 'array' then
      raise exception 'checked is a list of the fields a person says are right' using errcode = '22023';
    end if;
    for v_field in select pg_catalog.jsonb_array_elements_text(p -> 'checked') loop
      if v_field <> all (array['lpu_type_key'] || c_fields) then
        raise exception '% is not a field that can be checked', v_field using errcode = '22023';
      end if;
      if (v_prov -> v_field ->> 'from') = 'photo' and (v_prov -> v_field ->> 'checked_at') is null then
        v_prov := pg_catalog.jsonb_set(v_prov, array[v_field],
                    (v_prov -> v_field) || pg_catalog.jsonb_build_object('checked_by', v_actor, 'checked_at', v_now));
        v_checked := v_checked + 1;
      end if;
    end loop;
  end if;

  if v_before = '{}'::jsonb and v_checked = 0 then
    return pg_catalog.jsonb_build_object('station_lpu', case when v_exists then pg_catalog.to_jsonb(v_row) end,
                                         'changed', false, 'added_type', null);
  end if;

  v_doc := v_doc || pg_catalog.jsonb_build_object('provenance', v_prov, 'updated_at', v_now, 'updated_by', v_actor);
  v_row := pg_catalog.jsonb_populate_record(null::meganet.station_lpu, v_doc);
  insert into meganet.station_lpu as t (
      station_id, lpu_type_key, serial_no, firmware_version, bootloader_version, radio_firmware_version,
      os_version, program, note, provenance, updated_at, updated_by)
  values (
      v_row.station_id, v_row.lpu_type_key, v_row.serial_no, v_row.firmware_version, v_row.bootloader_version,
      v_row.radio_firmware_version, v_row.os_version, v_row.program, v_row.note, v_row.provenance, v_now, v_actor)
  on conflict (station_id) do update
     set lpu_type_key = excluded.lpu_type_key, serial_no = excluded.serial_no,
         firmware_version = excluded.firmware_version, bootloader_version = excluded.bootloader_version,
         radio_firmware_version = excluded.radio_firmware_version, os_version = excluded.os_version,
         program = excluded.program, note = excluded.note, provenance = excluded.provenance,
         updated_by = excluded.updated_by
  returning * into v_row;

  if v_before <> '{}'::jsonb then
    insert into meganet.station_lpu_change (station_id, changed_by, source, before, after)
    values (v_station, v_actor, 'person', v_before, v_after);
  end if;

  return pg_catalog.jsonb_build_object('station_lpu', pg_catalog.to_jsonb(v_row),
                                       'changed', v_before <> '{}'::jsonb, 'checked', v_checked,
                                       'added_type', v_added);
end;
$$;

comment on function meganet.save_station_lpu(jsonb, timestamptz) is
  'Record a station''s logger details (0089): its type — one on the list, or new_lpu_type with confirm_new once the editor has been shown the near ones — its serial number and version fields, and which photo-read values a person says are right (checked). Editors. Absent keys are left alone. Refuses a stale write (PT409) and a new type that is already on the list (23505, its key as the detail).';

-- ── 4. What the photo reader read ────────────────────────────────────────────

create table if not exists meganet.photo_reading (
  id              uuid        primary key default gen_random_uuid(),
  photo_id        uuid        not null references meganet.field_photo (id) on delete cascade,
  -- The station the photo was filed under when it was read: what was applied
  -- was applied there.
  station_id      text        references meganet.station (id) on delete set null,
  reader          text        not null,
  -- Raised when the reading itself changes enough to read every photo again.
  reader_version  integer     not null,
  -- What did the reading — the model, as the reader names it.
  model           text        not null default '',
  read_at         timestamptz not null default pg_catalog.now(),
  outcome         text        not null,
  summary         text        not null default '',
  -- What it sent, as sent: the LPU block, the equipment, its evidence.
  findings        jsonb       not null default '{}'::jsonb,
  -- What became of it: the LPU fields filled, agreed with, replaced and
  -- differing from the record; the equipment proposed, already known, refused.
  applied         jsonb       not null default '{}'::jsonb,

  constraint photo_reading_reader   check (reader ~ '^agent:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint photo_reading_version  check (reader_version >= 1),
  constraint photo_reading_outcome  check (outcome in ('nothing', 'found', 'unreadable')),
  constraint photo_reading_lengths  check (pg_catalog.length(summary) <= 1000 and pg_catalog.length(model) <= 100),
  constraint photo_reading_once     unique (photo_id, reader, reader_version)
);

comment on table meganet.photo_reading is
  'What the photo reader made of each field photo it read (0089): nothing to read, found something, or unreadable; a sentence saying what the photo shows; what it sent (findings) and what became of it (applied). One row per photo, reader and reader_version. Written only by record_photo_reading(); editors only.';

create index if not exists photo_reading_station_idx on meganet.photo_reading (station_id, read_at desc) where station_id is not null;
create index if not exists photo_reading_when_idx    on meganet.photo_reading (read_at desc);

-- Is this the service key, or a direct connection — the owner at a prompt, a
-- migration, a scheduled job holding the database's own password? The test
-- 0036's propose_equipment() makes, for the same reason: inside a definer
-- function current_user is the owner, so the role GUC is what names the caller.
-- Inlined below rather than made a function anybody could call.

--   { photo_id, reader: 'agent:<name>', reader_version, model,
--     outcome: 'nothing' | 'found' | 'unreadable', summary,
--     lpu: { lpu_type_key, serial_no, firmware_version, bootloader_version,
--            radio_firmware_version, os_version, program, confidence, evidence },
--     equipment: [ { equipment_key, make, model, serial_no, evidence, confidence } ] }
--
-- The LPU block is applied to the station the photo is filed under, by the two
-- rules at the head of this file, when it is at least half sure; the equipment
-- is proposed for the register (propose_equipment(), as the reader). Recorded
-- again for the same photo, reader and version, the reading replaces the one
-- before — applying a reading twice changes nothing the first did not.
create or replace function meganet.record_photo_reading(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_fields   constant text[] := array['lpu_type_key', 'serial_no', 'firmware_version', 'bootloader_version',
                                      'radio_firmware_version', 'os_version', 'program'];
  c_limit    constant integer[] := array[60, 64, 120, 120, 120, 120, 120];
  c_floor    constant numeric := 0.5;
  v_actor    text := meganet.actor();
  v_now      timestamptz := pg_catalog.now();
  v_trusted  boolean;
  v_key      text;
  v_photo    meganet.field_photo%rowtype;
  v_photo_id uuid;
  v_reader   text;
  v_version  integer;
  v_outcome  text;
  v_lpu      jsonb;
  v_items    jsonb;
  v_item     jsonb;
  v_conf     numeric;
  v_taken    timestamptz;
  v_row      meganet.station_lpu%rowtype;
  v_exists   boolean;
  v_doc      jsonb;
  v_prov     jsonb;
  v_mine     jsonb;
  v_i        integer;
  v_field    text;
  v_val      text;
  v_old      text;
  v_was      jsonb;
  v_same     boolean;
  v_filled   text[] := '{}';
  v_replaced text[] := '{}';
  v_agreed   text[] := '{}';
  v_differ   jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_before   jsonb := '{}'::jsonb;
  v_after    jsonb := '{}'::jsonb;
  v_lpu_out  jsonb := null;
  v_proposed jsonb := '[]'::jsonb;
  v_known    integer := 0;
  v_refused  jsonb := '[]'::jsonb;
  v_out      jsonb;
  v_msg      text;
  v_applied  jsonb;
  v_id       uuid;
begin
  v_trusted := v_actor = 'service_role'
               or (nullif(pg_catalog.current_setting('request.jwt.claims', true), '') is null
                   and coalesce(nullif(pg_catalog.current_setting('role', true), 'none'), current_user::text)
                       not in ('anon', 'authenticated', 'authenticator'));
  if not v_trusted then
    raise exception 'only the photo reader records readings — the service key, or a direct connection'
      using errcode = '42501',
            hint    = 'a person changes a station''s logger details through save_station_lpu()';
  end if;

  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.record_photo_reading() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('photo_id', 'reader', 'reader_version', 'model', 'outcome', 'summary', 'lpu', 'equipment') then
      raise exception 'meganet.record_photo_reading() does not take %', v_key
        using errcode = '22023',
              hint    = 'photo_id, reader, reader_version, model, outcome, summary, lpu and equipment are the whole list';
    end if;
  end loop;

  begin
    v_photo_id := (p ->> 'photo_id')::uuid;
  exception when others then
    raise exception 'photo_id has to be a uuid, not %', coalesce(p ->> 'photo_id', 'nothing') using errcode = '22023';
  end;
  select * into v_photo from meganet.field_photo where id = v_photo_id and deleted_at is null;
  if not found then
    raise exception 'no such field photo: %', v_photo_id using errcode = '23503';
  end if;
  v_taken := coalesce(v_photo.taken_at, v_photo.created_at);

  v_reader := coalesce(p ->> 'reader', '');
  if v_reader !~ '^agent:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' then
    raise exception 'reader is ''agent:<name>'', not %', coalesce(nullif(v_reader, ''), 'nothing') using errcode = '22023';
  end if;
  begin
    v_version := (p ->> 'reader_version')::integer;
  exception when others then
    raise exception 'reader_version is a whole number' using errcode = '22023';
  end;
  if v_version is null or v_version < 1 then
    raise exception 'reader_version is a whole number from 1' using errcode = '22023';
  end if;
  v_outcome := coalesce(p ->> 'outcome', '');
  if v_outcome not in ('nothing', 'found', 'unreadable') then
    raise exception 'outcome is nothing, found or unreadable, not %', coalesce(nullif(v_outcome, ''), 'nothing')
      using errcode = '22023';
  end if;

  v_lpu := p -> 'lpu';
  if v_lpu is not null and pg_catalog.jsonb_typeof(v_lpu) = 'null' then
    v_lpu := null;
  end if;
  if v_lpu is not null and pg_catalog.jsonb_typeof(v_lpu) <> 'object' then
    raise exception 'lpu is an object' using errcode = '22023';
  end if;
  v_items := coalesce(p -> 'equipment', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_items) = 'null' then
    v_items := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(v_items) <> 'array' then
    raise exception 'equipment is a list' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_items) > 30 then
    raise exception 'thirty pieces of equipment in one photo is more than one photo shows' using errcode = '22023';
  end if;

  -- ── The logger ────────────────────────────────────────────────────────────
  if v_lpu is not null then
    for v_key in select pg_catalog.jsonb_object_keys(v_lpu) loop
      if v_key <> all (c_fields || array['confidence', 'evidence']) then
        raise exception 'lpu does not take %', v_key using errcode = '22023';
      end if;
    end loop;
    begin
      v_conf := (v_lpu ->> 'confidence')::numeric;
    exception when others then
      raise exception 'lpu.confidence is a number from 0 to 1' using errcode = '22023';
    end;
    if v_conf is null or v_conf < 0 or v_conf > 1 then
      raise exception 'lpu.confidence is a number from 0 to 1' using errcode = '22023';
    end if;

    if v_photo.station_id is null then
      v_lpu_out := pg_catalog.jsonb_build_object('skipped', 'the photo is not filed under a station');
    elsif v_conf < c_floor then
      v_lpu_out := pg_catalog.jsonb_build_object('skipped', pg_catalog.format('only %s sure — kept with the reading, not applied', v_conf));
    else
      select * into v_row from meganet.station_lpu where station_id = v_photo.station_id for update;
      v_exists := found;
      if v_exists then
        v_doc := pg_catalog.to_jsonb(v_row);
      else
        v_doc := pg_catalog.jsonb_build_object('station_id', v_photo.station_id, 'lpu_type_key', null, 'serial_no', '',
                   'firmware_version', '', 'bootloader_version', '', 'radio_firmware_version', '',
                   'os_version', '', 'program', '', 'note', '', 'provenance', '{}'::jsonb);
      end if;
      v_prov := coalesce(v_doc -> 'provenance', '{}'::jsonb);
      v_mine := pg_catalog.jsonb_build_object('from', 'photo', 'by', v_reader, 'at', v_now, 'photo_id', v_photo_id,
                                              'taken_at', v_taken, 'confidence', v_conf);

      for v_i in 1 .. pg_catalog.array_length(c_fields, 1) loop
        v_field := c_fields[v_i];
        continue when not v_lpu ? v_field or pg_catalog.jsonb_typeof(v_lpu -> v_field) = 'null';
        v_val := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(v_lpu ->> v_field, ''), '\s+', ' ', 'g'));
        continue when v_val = '';
        if pg_catalog.length(v_val) > c_limit[v_i] then
          v_skipped := v_skipped || pg_catalog.jsonb_build_object('field', v_field, 'why', 'too long');
          continue;
        end if;
        if v_field = 'lpu_type_key' and not exists (select 1 from meganet.lpu_type where key = v_val) then
          v_skipped := v_skipped || pg_catalog.jsonb_build_object('field', v_field, 'value', v_val,
                         'why', 'not on the LPU type list — only a person adds a type');
          continue;
        end if;

        v_old := coalesce(v_doc ->> v_field, '');
        v_was := v_prov -> v_field;
        v_same := case when v_field = 'serial_no' then meganet.equipment_serial_key(v_old) = meganet.equipment_serial_key(v_val)
                       else pg_catalog.upper(pg_catalog.regexp_replace(v_old, '\s+', '', 'g'))
                          = pg_catalog.upper(pg_catalog.regexp_replace(v_val, '\s+', '', 'g')) end;

        if v_old = '' then
          v_filled := v_filled || v_field;
        elsif v_same then
          v_agreed := v_agreed || v_field;
          continue;
        elsif (v_was ->> 'from') = 'photo' and (v_was ->> 'checked_at') is null
              and (v_was ->> 'taken_at') is not null and (v_was ->> 'taken_at')::timestamptz < v_taken then
          v_replaced := v_replaced || v_field;
        else
          v_differ := v_differ || pg_catalog.jsonb_build_object('field', v_field, 'recorded', v_old, 'read', v_val,
                                                                'taken_at', v_taken);
          continue;
        end if;

        v_before := v_before || pg_catalog.jsonb_build_object(v_field, case when v_field = 'lpu_type_key' and v_old = '' then null else pg_catalog.to_jsonb(v_old) end);
        v_after  := v_after  || pg_catalog.jsonb_build_object(v_field, v_val);
        v_doc    := v_doc    || pg_catalog.jsonb_build_object(v_field, v_val);
        v_prov   := v_prov   || pg_catalog.jsonb_build_object(v_field, v_mine);
      end loop;

      if v_before <> '{}'::jsonb then
        v_doc := v_doc || pg_catalog.jsonb_build_object('provenance', v_prov);
        v_row := pg_catalog.jsonb_populate_record(null::meganet.station_lpu, v_doc);
        insert into meganet.station_lpu as t (
            station_id, lpu_type_key, serial_no, firmware_version, bootloader_version, radio_firmware_version,
            os_version, program, note, provenance, updated_at, updated_by)
        values (
            v_row.station_id, v_row.lpu_type_key, v_row.serial_no, v_row.firmware_version, v_row.bootloader_version,
            v_row.radio_firmware_version, v_row.os_version, v_row.program, v_row.note, v_row.provenance, v_now, v_reader)
        on conflict (station_id) do update
           set lpu_type_key = excluded.lpu_type_key, serial_no = excluded.serial_no,
               firmware_version = excluded.firmware_version, bootloader_version = excluded.bootloader_version,
               radio_firmware_version = excluded.radio_firmware_version, os_version = excluded.os_version,
               program = excluded.program, provenance = excluded.provenance, updated_by = excluded.updated_by;
        insert into meganet.station_lpu_change (station_id, changed_by, source, photo_id, before, after)
        values (v_photo.station_id, v_reader, 'photo', v_photo_id, v_before, v_after);
      end if;

      v_lpu_out := pg_catalog.jsonb_build_object('filled', pg_catalog.to_jsonb(v_filled), 'replaced', pg_catalog.to_jsonb(v_replaced),
                                                 'agreed', pg_catalog.to_jsonb(v_agreed), 'differed', v_differ,
                                                 'skipped', v_skipped);
    end if;
  end if;

  -- ── Everything else in the photo ──────────────────────────────────────────
  for v_item in select pg_catalog.jsonb_array_elements(v_items) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_refused := v_refused || pg_catalog.jsonb_build_object('why', 'not an object');
      continue;
    end if;
    if (v_item ->> 'equipment_key') = 'key_number' then
      v_refused := v_refused || pg_catalog.jsonb_build_object('equipment_key', 'key_number',
                     'why', 'site codes and key numbers live only in the inspection records');
      continue;
    end if;
    begin
      v_out := meganet.propose_equipment(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                 'photo_id', v_photo_id,
                 'equipment_key', v_item ->> 'equipment_key',
                 'make', v_item ->> 'make',
                 'model', v_item ->> 'model',
                 'serial_no', v_item ->> 'serial_no',
                 'evidence', v_item ->> 'evidence',
                 'confidence', v_item -> 'confidence',
                 'proposed_by', v_reader)));
      v_proposed := v_proposed || pg_catalog.to_jsonb(v_out ->> 'id');
    exception
      when unique_violation then
        v_known := v_known + 1;
      when others then
        get stacked diagnostics v_msg = message_text;
        v_refused := v_refused || pg_catalog.jsonb_build_object('equipment_key', v_item ->> 'equipment_key',
                       'why', pg_catalog.left(v_msg, 300));
    end;
  end loop;

  v_applied := pg_catalog.jsonb_build_object(
                 'lpu', v_lpu_out,
                 'equipment', pg_catalog.jsonb_build_object('proposed', v_proposed, 'known', v_known, 'refused', v_refused));

  insert into meganet.photo_reading (photo_id, station_id, reader, reader_version, model, outcome, summary,
                                     findings, applied, read_at)
  values (v_photo_id, v_photo.station_id, v_reader, v_version,
          pg_catalog.left(coalesce(p ->> 'model', ''), 100), v_outcome,
          pg_catalog.left(coalesce(p ->> 'summary', ''), 1000),
          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('lpu', v_lpu, 'equipment', v_items)),
          v_applied, v_now)
  on conflict (photo_id, reader, reader_version) do update
     set station_id = excluded.station_id, model = excluded.model, outcome = excluded.outcome,
         summary = excluded.summary, findings = excluded.findings, applied = excluded.applied,
         read_at = excluded.read_at
  returning id into v_id;

  return pg_catalog.jsonb_build_object('reading_id', v_id, 'photo_id', v_photo_id,
                                       'station_id', v_photo.station_id, 'applied', v_applied);
end;
$$;

comment on function meganet.record_photo_reading(jsonb) is
  'Record what the photo reader read off one field photo (0089), and apply it: the LPU block to the station''s logger details — filling only what nobody recorded, never over a person''s value, a photo''s unchecked value giving way only to a later photo — and each other piece of equipment to the register''s queue through propose_equipment(). Key numbers refused. The service key or a direct connection only. Recorded again for the same photo, reader and version, it replaces the reading before.';

-- Many readings in one call: a night's run reads tens of photos and most show
-- nothing to read, so the reader sends them together —
--
--   { reader, reader_version, model, readings: [ { photo_id, outcome, summary, lpu, equipment }, … ] }
--
-- — each recorded by record_photo_reading() as if sent alone, in its own
-- subtransaction: one the function refuses is said in `failed` with why, and
-- the rest are recorded. What comes back is short, for an agent to read: how
-- many, the fields filled at which stations, and the counts.
create or replace function meganet.record_photo_readings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    text := meganet.actor();
  v_key      text;
  v_item     jsonb;
  v_out      jsonb;
  v_ok       integer := 0;
  v_failed   jsonb := '[]'::jsonb;
  v_filled   jsonb := '[]'::jsonb;
  v_differed integer := 0;
  v_proposed integer := 0;
  v_known    integer := 0;
  v_msg      text;
begin
  if not (v_actor = 'service_role'
          or (nullif(pg_catalog.current_setting('request.jwt.claims', true), '') is null
              and coalesce(nullif(pg_catalog.current_setting('role', true), 'none'), current_user::text)
                  not in ('anon', 'authenticated', 'authenticator'))) then
    raise exception 'only the photo reader records readings — the service key, or a direct connection' using errcode = '42501';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' or pg_catalog.jsonb_typeof(p -> 'readings') is distinct from 'array' then
    raise exception 'meganet.record_photo_readings() needs { reader, reader_version, model, readings: [...] }' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('reader', 'reader_version', 'model', 'readings') then
      raise exception 'meganet.record_photo_readings() does not take %', v_key using errcode = '22023';
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(p -> 'readings') > 200 then
    raise exception 'at most 200 readings in one call' using errcode = '22023';
  end if;

  for v_item in select pg_catalog.jsonb_array_elements(p -> 'readings') loop
    begin
      if pg_catalog.jsonb_typeof(v_item) <> 'object' then
        raise exception 'a reading is an object' using errcode = '22023';
      end if;
      v_out := meganet.record_photo_reading(
                 pg_catalog.jsonb_build_object('reader', p -> 'reader', 'reader_version', p -> 'reader_version',
                                               'model', coalesce(p -> 'model', '""'::jsonb))
                 || (v_item - 'reader' - 'reader_version' - 'model'));
      v_ok := v_ok + 1;
      if pg_catalog.jsonb_array_length(coalesce(v_out -> 'applied' -> 'lpu' -> 'filled', '[]'::jsonb))
         + pg_catalog.jsonb_array_length(coalesce(v_out -> 'applied' -> 'lpu' -> 'replaced', '[]'::jsonb)) > 0 then
        v_filled := v_filled || pg_catalog.jsonb_build_object('station_id', v_out ->> 'station_id',
                      'fields', coalesce(v_out -> 'applied' -> 'lpu' -> 'filled', '[]'::jsonb)
                                || coalesce(v_out -> 'applied' -> 'lpu' -> 'replaced', '[]'::jsonb));
      end if;
      v_differed := v_differed + pg_catalog.jsonb_array_length(coalesce(v_out -> 'applied' -> 'lpu' -> 'differed', '[]'::jsonb));
      v_proposed := v_proposed + pg_catalog.jsonb_array_length(coalesce(v_out -> 'applied' -> 'equipment' -> 'proposed', '[]'::jsonb));
      v_known    := v_known + coalesce((v_out -> 'applied' -> 'equipment' ->> 'known')::integer, 0);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_failed := v_failed || pg_catalog.jsonb_build_object('photo_id', v_item ->> 'photo_id', 'why', pg_catalog.left(v_msg, 300));
    end;
  end loop;

  return pg_catalog.jsonb_build_object('recorded', v_ok, 'failed', v_failed, 'filled', v_filled,
                                       'differed', v_differed, 'proposed', v_proposed, 'known', v_known);
end;
$$;

comment on function meganet.record_photo_readings(jsonb) is
  'Record up to 200 of the photo reader''s readings in one call (0089), each through record_photo_reading() in its own subtransaction: a refused one is listed in failed, with why, and the rest are recorded. Answers the counts and the fields filled. The service key or a direct connection only.';

-- The photos the reader has still to read: live, and not read by this reader
-- at this version or a later one. Oldest first, so a backlog is worked through
-- in the order it arrived; at most a thousand at a time. The service key or a
-- direct connection only — it names every photo's file.
create or replace function meganet.photos_to_read(p_reader text, p_version integer default 1, p_limit integer default 200)
returns table (id uuid, station_id text, station_name text, station_number text, storage_path text,
               content_type text, byte_size bigint, width integer, height integer, taken_at timestamptz,
               title text, caption text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor text := meganet.actor();
begin
  if not (v_actor = 'service_role'
          or (nullif(pg_catalog.current_setting('request.jwt.claims', true), '') is null
              and coalesce(nullif(pg_catalog.current_setting('role', true), 'none'), current_user::text)
                  not in ('anon', 'authenticated', 'authenticator'))) then
    raise exception 'only the photo reader asks what it has still to read' using errcode = '42501';
  end if;
  return query
    select f.id, f.station_id, s.name, s.station_number, f.storage_path, f.content_type, f.byte_size,
           f.width, f.height, f.taken_at, f.title, f.caption, f.created_at
      from meganet.field_photo f
      left join meganet.station s on s.id = f.station_id
     where f.deleted_at is null
       and not exists (select 1 from meganet.photo_reading r
                        where r.photo_id = f.id and r.reader = p_reader and r.reader_version >= coalesce(p_version, 1))
     order by f.created_at, f.id
     limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;

comment on function meganet.photos_to_read(text, integer, integer) is
  'The live field photos this reader has not read at this version or a later one, oldest first, at most 1,000 (0089). The service key or a direct connection only.';

-- ── Row level security ───────────────────────────────────────────────────────
-- Four tables, RLS in the same file (db/README.md). None has a policy for any
-- write: the functions above write, and service_role.

alter table meganet.lpu_type           enable row level security;
alter table meganet.station_lpu        enable row level security;
alter table meganet.station_lpu_change enable row level security;
alter table meganet.photo_reading      enable row level security;

drop policy if exists lpu_type_read_all on meganet.lpu_type;
create policy lpu_type_read_all on meganet.lpu_type for select using (true);

drop policy if exists station_lpu_read_members on meganet.station_lpu;
create policy station_lpu_read_members on meganet.station_lpu
  for select to authenticated
  using ((select meganet.is_member()));

drop policy if exists station_lpu_change_read_editors on meganet.station_lpu_change;
create policy station_lpu_change_read_editors on meganet.station_lpu_change
  for select to authenticated
  using ((select meganet.is_editor()));

drop policy if exists photo_reading_read_editors on meganet.photo_reading;
create policy photo_reading_read_editors on meganet.photo_reading
  for select to authenticated
  using ((select meganet.is_editor()));

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.lpu_match_key(text)                           from public;
revoke all on function meganet.save_station_lpu(jsonb, timestamptz)          from public;
revoke all on function meganet.record_photo_reading(jsonb)                   from public;
revoke all on function meganet.record_photo_readings(jsonb)                  from public;
revoke all on function meganet.photos_to_read(text, integer, integer)        from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Said out loud, and re-said on every run, for 0010's reason.
  revoke insert, update, delete, truncate on
      meganet.lpu_type, meganet.station_lpu, meganet.station_lpu_change, meganet.photo_reading
    from anon, authenticated;
  revoke all on meganet.station_lpu, meganet.station_lpu_change, meganet.photo_reading from anon;

  grant select on meganet.lpu_type to anon, authenticated;
  grant select on meganet.station_lpu, meganet.station_lpu_change, meganet.photo_reading to authenticated;
  grant select, insert, update, delete on
      meganet.lpu_type, meganet.station_lpu, meganet.station_lpu_change, meganet.photo_reading
    to service_role;

  grant execute on function meganet.lpu_match_key(text)                      to anon, authenticated, service_role;
  grant execute on function meganet.save_station_lpu(jsonb, timestamptz)     to authenticated, service_role;
  grant execute on function meganet.record_photo_reading(jsonb)              to service_role;
  grant execute on function meganet.record_photo_readings(jsonb)             to service_role;
  grant execute on function meganet.photos_to_read(text, integer, integer)   to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes to 89 once this is applied (CLAUDE.md).
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '89')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
