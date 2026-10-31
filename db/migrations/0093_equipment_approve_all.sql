-- 0093_equipment_approve_all.sql — Equipment suggestions approved by the
-- hundred, and a sighting with less in it never again mistaken for a
-- replacement.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0093_equipment_approve_all.sql
--
-- Why this file exists
-- ────────────────────
-- The photo reader's first run (0090, docs/photo-reader.md) proposed 318
-- pieces of equipment for the register, and an administrator approving them
-- one by one found two things wrong:
--
--   * It is 318 clicks. approve_equipment_suggestions() approves what is
--     waiting in one call — all of it, one station's, or what the reader was
--     at least so sure of — and the Review panel has a button for it.
--   * Five of the first 22 approvals retired a unit that was not replaced.
--     decide_equipment_suggestion() (0036) took a unit to be the same only by
--     its serial, or by its model when it had no serial; anything else with
--     one unit of the kind on the register was a replacement. So a photo
--     showing only "Kisters" on a bubbler retired the Kisters WL3100 the
--     register knew by its serial, from a photo of the same visit; and a
--     battery filed as `other` retired another `other`.
--
-- What changes
-- ────────────
--   1. equipment_compatible() — two descriptions of a unit that do not
--      contradict each other: a make, a model and a serial each blank on one
--      side or the same on both, the make matched as a prefix (Victron is
--      Victron Energy) and the model and serial exactly, by their letters and
--      digits.
--   2. decide_equipment_suggestion(), 0036's restated with two rules changed
--      and nothing else: rule 3 — the unit this sighting does not contradict
--      is the unit it is a sighting of (a make alone is that unit seen again;
--      a model or a serial is what it lacked) — and rule 4 never takes an
--      `other` to have replaced another `other`. A different model, or a
--      different serial, with one unit of the kind on the register is still
--      a replacement; two that could be it still asks which.
--   3. approve_equipment_suggestions() — administrators. Every suggestion it
--      approves goes through decide_equipment_suggestion(), as the same unit
--      where the register has it and otherwise alongside: it never retires
--      anything, because a pile of sightings says what is there, not what
--      was swapped. One that could be either of two units is left waiting,
--      with why. The most telling first — a serial, then a model — so a
--      sighting with less in it meets the unit it is a sighting of.
--   4. repair_same_unit_retirements() — run once below, and the service
--      key's afterwards: a unit retired as replaced by a unit it does not
--      contradict, both off photos taken the same day, was one unit recorded
--      twice — the live row gets what the retired one knew, and the retired
--      one says so; an `other` retired by an `other` it contradicts is put
--      back. A replacement that contradicts what it replaced is left alone.
--
-- Depends on 0035 (field_photo) and 0036 (the register, its suggestions,
-- is_admin, equipment_serial_key). tools/check_equipment_approve_all.sql
-- proves it; tools/check_photo_review.sql still proves 0036's other rules.

-- ── 1. Two descriptions of one unit ─────────────────────────────────────────

create or replace function meganet.equipment_compatible(
         p_make1 text, p_model1 text, p_serial1 text, p_make2 text, p_model2 text, p_serial2 text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  with k as (
    select meganet.equipment_serial_key(p_make1) as a1, meganet.equipment_serial_key(p_make2) as a2,
           meganet.equipment_serial_key(p_model1) as m1, meganet.equipment_serial_key(p_model2) as m2,
           meganet.equipment_serial_key(p_serial1) as s1, meganet.equipment_serial_key(p_serial2) as s2)
  select (a1 = '' or a2 = '' or pg_catalog.starts_with(a1, a2) or pg_catalog.starts_with(a2, a1))
     and (m1 = '' or m2 = '' or m1 = m2)
     and (s1 = '' or s2 = '' or s1 = s2)
    from k;
$$;

comment on function meganet.equipment_compatible(text, text, text, text, text, text) is
  'Whether two descriptions of a unit — make, model, serial — do not contradict each other (0093): each blank on one side or the same on both, the make matched as a prefix (Victron is Victron Energy), the model and the serial by their letters and digits.';

-- ── 2. Deciding — 0036's, with rules 3 and 4 as above ───────────────────────

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

    -- 3. The unit this sighting does not contradict (0093): a make, a model
    -- and a serial each blank on one side or the same on both — the make
    -- matched as a prefix, so Victron is Victron Energy. A photo showing only
    -- the make of a unit the register knows in full is that unit seen again,
    -- and so is one that adds a model or a serial to a unit known by less.
    -- Before 0093 only a serial or the same model counted, and a sighting
    -- with less in it retired the unit it was a sighting of.
    if not v_found then
      select count(*) into v_n from meganet.station_equipment e
       where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
         and meganet.equipment_compatible(e.make, e.model, e.serial_no, v_make, v_model, v_serial);
      if v_n = 1 then
        select * into v_unit from meganet.station_equipment e
         where e.station_id = v_s.station_id and e.equipment_key = v_key and e.retired_at is null
           and meganet.equipment_compatible(e.make, e.model, e.serial_no, v_make, v_model, v_serial)
         for update;
        v_found := true;
      elsif v_n > 1 then
        raise exception 'there are % live % units at this station that could be this one — say which it replaces, or that it is added alongside',
          v_n, pg_catalog.lower(v_kind.label)
          using errcode = '22023',
                hint    = 'approve with replaces: the id of the unit, or replaces: null to add it alongside';
      end if;
    end if;

    -- 4 and 5. Some other unit of the kind — except `other`, which is not a
    -- kind of unit but everything else (a battery, a surge arrester, a relay),
    -- so one is never taken to have replaced another: it is added alongside.
    if not v_found and v_key <> 'other' then
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
  'Approve or reject an equipment suggestion. Administrators only (meganet.is_admin()). Approve takes corrections (equipment_key, make, model, serial_no, note, replaces), writes the station''s register — updating the same unit (by serial, or the one unit the sighting does not contradict, 0093), retiring the one it replaced (never an other for an other) — and supersedes the other pending suggestions for that unit.';

-- ── 3. Approving what is waiting, in one call ───────────────────────────────
--
--   { station_id, proposed_by, min_confidence, ids: [...], note }   all optional
--
-- At most 500 in a call; `remaining` says how many more match, for a caller to
-- ask again. Administrators only — and every approval is still
-- decide_equipment_suggestion()'s, which asks the same.
create or replace function meganet.approve_equipment_suggestions(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max      constant integer := 500;
  v_key      text;
  v_ids      uuid[];
  v_station  text;
  v_by       text;
  v_min      numeric;
  v_note     text;
  v_s        meganet.equipment_suggestion%rowtype;
  v_label    text;
  v_n        integer;
  v_same     boolean;
  v_patch    jsonb;
  v_out      jsonb;
  v_merged   integer := 0;
  v_added    integer := 0;
  v_super    integer := 0;
  v_left     jsonb := '[]'::jsonb;
  v_msg      text;
  v_remain   integer;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator may approve equipment suggestions'
      using errcode = '42501',
            hint    = 'an administrator is an editor whose meganet.app_user row says role = ''admin''';
  end if;
  p := coalesce(p, '{}'::jsonb);
  if pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.approve_equipment_suggestions() takes a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('ids', 'station_id', 'proposed_by', 'min_confidence', 'note') then
      raise exception 'meganet.approve_equipment_suggestions() does not take %', v_key
        using errcode = '22023', hint = 'ids, station_id, proposed_by, min_confidence and note are the whole list';
    end if;
  end loop;
  if p ? 'ids' then
    if pg_catalog.jsonb_typeof(p -> 'ids') <> 'array' then
      raise exception 'ids is a list of suggestion ids' using errcode = '22023';
    end if;
    begin
      select pg_catalog.array_agg(x::uuid) into v_ids from pg_catalog.jsonb_array_elements_text(p -> 'ids') x;
    exception when others then
      raise exception 'ids is a list of suggestion ids (uuids)' using errcode = '22023';
    end;
    v_ids := coalesce(v_ids, '{}');
  end if;
  v_station := nullif(pg_catalog.btrim(coalesce(p ->> 'station_id', '')), '');
  v_by      := nullif(pg_catalog.btrim(coalesce(p ->> 'proposed_by', '')), '');
  begin
    v_min := nullif(p ->> 'min_confidence', '')::numeric;
  exception when others then
    raise exception 'min_confidence is a number from 0 to 1' using errcode = '22023';
  end;
  if v_min is not null and (v_min < 0 or v_min > 1) then
    raise exception 'min_confidence is a number from 0 to 1' using errcode = '22023';
  end if;
  v_note := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(coalesce(p ->> 'note', '')), ''),
                                     'Approved with the others waiting, in one go'), 1000);

  for v_s in
    select s.* from meganet.equipment_suggestion s
     where s.status = 'pending'
       and (v_ids is null or s.id = any (v_ids))
       and (v_station is null or s.station_id = v_station)
       and (v_by is null or s.proposed_by = v_by)
       and (v_min is null or coalesce(s.confidence, 0) >= v_min)
     order by s.station_id, s.equipment_key,
              (meganet.equipment_serial_key(s.serial_no) <> '') desc,
              (meganet.equipment_serial_key(s.model) <> '') desc,
              s.confidence desc nulls last, s.created_at, s.id
     limit c_max
  loop
    -- An approval earlier in this call may have superseded it.
    continue when (select status from meganet.equipment_suggestion where id = v_s.id) <> 'pending';
    begin
      select label into v_label from meganet.equipment_kind where key = v_s.equipment_key;
      if meganet.equipment_serial_key(v_s.serial_no) <> '' and exists (
           select 1 from meganet.station_equipment e
            where e.station_id = v_s.station_id and e.equipment_key = v_s.equipment_key and e.retired_at is null
              and meganet.equipment_serial_key(e.serial_no) = meganet.equipment_serial_key(v_s.serial_no)) then
        v_same := true;
      else
        select count(*) into v_n from meganet.station_equipment e
         where e.station_id = v_s.station_id and e.equipment_key = v_s.equipment_key and e.retired_at is null
           and meganet.equipment_compatible(e.make, e.model, e.serial_no, v_s.make, v_s.model, v_s.serial_no);
        if v_n > 1 then
          v_left := v_left || pg_catalog.jsonb_build_object('id', v_s.id, 'station_id', v_s.station_id,
                      'why', pg_catalog.format('it could be any of %s %s units on the register — decide it by hand',
                                               v_n, pg_catalog.lower(coalesce(v_label, v_s.equipment_key))));
          continue;
        end if;
        v_same := v_n = 1;
      end if;
      -- The same unit as the register sees it; otherwise alongside, said
      -- outright, so that nothing is ever taken to have been replaced.
      v_patch := case when v_same then null else '{"replaces": null}'::jsonb end;
      v_out := meganet.decide_equipment_suggestion(v_s.id, 'approve', v_note, v_patch);
      if v_same then v_merged := v_merged + 1; else v_added := v_added + 1; end if;
      v_super := v_super + coalesce((v_out ->> 'superseded')::integer, 0);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_left := v_left || pg_catalog.jsonb_build_object('id', v_s.id, 'station_id', v_s.station_id,
                  'why', pg_catalog.left(v_msg, 300));
    end;
  end loop;

  select count(*) into v_remain from meganet.equipment_suggestion s
   where s.status = 'pending'
     and (v_ids is null or s.id = any (v_ids))
     and (v_station is null or s.station_id = v_station)
     and (v_by is null or s.proposed_by = v_by)
     and (v_min is null or coalesce(s.confidence, 0) >= v_min)
     and not exists (select 1 from pg_catalog.jsonb_array_elements(v_left) l where (l ->> 'id')::uuid = s.id);

  return pg_catalog.jsonb_build_object('approved', v_merged + v_added, 'merged', v_merged, 'added', v_added,
                                       'superseded', v_super, 'left', v_left, 'remaining', v_remain);
end;
$$;

comment on function meganet.approve_equipment_suggestions(jsonb) is
  'Approve the equipment suggestions waiting — all, one station''s (station_id), one proposer''s (proposed_by), those at least min_confidence sure, or the ids given — up to 500 a call (0093). Administrators only. Each through decide_equipment_suggestion(): the same unit where the register has it, otherwise added alongside; never retires anything. One that could be either of two units is left waiting, with why. Answers approved, merged, added, superseded, left and remaining.';

-- ── 4. The retirements that were one unit recorded twice ─────────────────────
-- A unit retired as replaced by a unit it does not contradict, both read off
-- photos taken the same day: the same unit, recorded twice. The live row gets
-- what the retired one knew — its make, model or serial where the live one
-- has none — and the retired row says it was recorded twice. An `other`
-- retired by an `other` it contradicts was never replaced: it is put back. A
-- replacement that contradicts what it replaced — another model, another
-- serial — is a replacement, and left alone.
create or replace function meganet.repair_same_unit_retirements()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_note    constant text := 'Recorded twice: the same unit as the one that took its place, seen in another photo of the same visit (0093).';
  v_actor   text := meganet.actor();
  v_old     meganet.station_equipment%rowtype;
  v_new     meganet.station_equipment%rowtype;
  v_day_old date;
  v_day_new date;
  v_merged  integer := 0;
  v_back    integer := 0;
  v_skipped integer := 0;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator may repair the register' using errcode = '42501';
  end if;
  for v_old in
    select o.* from meganet.station_equipment o
     where o.retired_at is not null and o.replaced_by is not null
       and pg_catalog.strpos(o.note, 'Recorded twice:') = 0
     order by o.retired_at
     for update
  loop
    select * into v_new from meganet.station_equipment where id = v_old.replaced_by and retired_at is null for update;
    continue when not found;
    v_day_old := (select (f.taken_at at time zone 'Australia/Brisbane')::date from meganet.field_photo f where f.id = v_old.photo_id);
    v_day_new := (select (f.taken_at at time zone 'Australia/Brisbane')::date from meganet.field_photo f where f.id = v_new.photo_id);
    continue when v_day_old is null or v_day_new is null or v_day_old <> v_day_new;

    if meganet.equipment_compatible(v_old.make, v_old.model, v_old.serial_no, v_new.make, v_new.model, v_new.serial_no) then
      if meganet.equipment_serial_key(v_new.serial_no) = '' and meganet.equipment_serial_key(v_old.serial_no) <> ''
         and exists (select 1 from meganet.station_equipment e
                      where e.station_id = v_new.station_id and e.equipment_key = v_new.equipment_key
                        and e.retired_at is null and e.id <> v_new.id
                        and meganet.equipment_serial_key(e.serial_no) = meganet.equipment_serial_key(v_old.serial_no)) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      update meganet.station_equipment
         set make      = case when meganet.equipment_serial_key(make) = '' then v_old.make
                              when pg_catalog.length(v_old.make) > pg_catalog.length(make)
                               and pg_catalog.starts_with(meganet.equipment_serial_key(v_old.make), meganet.equipment_serial_key(make))
                              then v_old.make else make end,
             model     = case when meganet.equipment_serial_key(model) = '' then v_old.model else model end,
             serial_no = case when meganet.equipment_serial_key(serial_no) = '' then v_old.serial_no else serial_no end,
             updated_by = v_actor
       where id = v_new.id;
      update meganet.station_equipment
         set note = pg_catalog.left(c_note || case when note <> '' then ' ' || note else '' end, 1000),
             updated_by = v_actor
       where id = v_old.id;
      v_merged := v_merged + 1;
    elsif v_old.equipment_key = 'other' then
      if meganet.equipment_serial_key(v_old.serial_no) <> '' and exists (
           select 1 from meganet.station_equipment e
            where e.station_id = v_old.station_id and e.equipment_key = 'other' and e.retired_at is null
              and meganet.equipment_serial_key(e.serial_no) = meganet.equipment_serial_key(v_old.serial_no)) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      update meganet.station_equipment
         set retired_at = null, retired_by = null, replaced_by = null, updated_by = v_actor
       where id = v_old.id;
      v_back := v_back + 1;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('merged', v_merged, 'put_back', v_back, 'skipped', v_skipped);
end;
$$;

comment on function meganet.repair_same_unit_retirements() is
  'Undo the retirements that were one unit recorded twice (0093): a unit retired as replaced by one it does not contradict, off photos taken the same day, gives what it knew to the live row and says it was recorded twice; an other retired by an other it contradicts is put back. Leaves a real replacement alone. Run once by 0093; the service key''s after.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.equipment_compatible(text, text, text, text, text, text) from public;
revoke all on function meganet.approve_equipment_suggestions(jsonb)                     from public;
revoke all on function meganet.repair_same_unit_retirements()                           from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.equipment_compatible(text, text, text, text, text, text) to authenticated, service_role;
  grant execute on function meganet.approve_equipment_suggestions(jsonb)                     to authenticated, service_role;
  grant execute on function meganet.repair_same_unit_retirements()                           to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── The repair, once ─────────────────────────────────────────────────────────
-- As the owner, which is_admin() says yes to. A database with nothing to
-- repair — every one but the live one, on 31 October 2026 — changes nothing.

select meganet.repair_same_unit_retirements();

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes to 93 once this is applied (CLAUDE.md).
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '93')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
