-- 0011_printed_boxes.sql — Nine boxes the paper prints and 0009 had no column for.
--
-- Issues #146 and #148, both sub-issues of #78, and paired here for the reason
-- both of them give: they are the same shape and the same apply. Both were found
-- by building the forms rather than by reading the schema — #146 while #116 drew
-- the six inspection sheets, #148 while #117 drew the Council sheet — and both
-- were left visible on the form in the meantime, in the dashed "Printed on this
-- sheet, with nowhere to record it yet" block. This file is what lets those two
-- notes come off.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0011_printed_boxes.sql
--
-- ── Why nine columns and not nine judgement calls ────────────────────────────
--
-- Every column below is a box printed on a sheet in
-- `archive/Inspection sheets for printing.xlsx`, named in the comment with the
-- sheet and the cell it came off. None of them is a field somebody thought would
-- be useful. That distinction is 0009's decision 1 and it is why this migration
-- is short: the paper decides, so there is nothing to argue about.
--
-- The two halves are unrelated to each other except in when they are applied.
-- #146 is five boxes on two of the six inspection sheets; #148 is four boxes on
-- the one Council sheet. They share a file because two migrations against
-- `meganet.inspection_power` and `meganet.maintenance_asset` in one apply is one
-- window rather than two, and because neither is big enough to be worth its own
-- schema_version.
--
-- ── #148 is a loss being repaired, not a gap being filled ────────────────────
--
-- Worth stating because the two halves read differently. #146's five boxes had
-- nowhere to go, so nothing was recorded and nothing was wrong. #148's four had
-- somewhere to go that was *near enough to look right*: `maintenance_asset` has
-- one `condition_key` and one `owner_key`, the Comms and Power panel prints
-- three of each, and #117 stored the Comms sub-column's pair as the panel's.
-- The filled `Council Maint Tasks Mt Kanigan` sheet answers the three Condition
-- boxes differently — Comms poor, Equipment good, Power good — so digitising
-- that site before this migration records "the panel is poor" and silently drops
-- the fact that only the comms third of it is. A wrong answer, not a missing one.
--
-- The existing pair is kept meaning the Comms sub-column rather than renamed.
-- On the rainfall and water-level panels it still means the whole panel, because
-- those panels print one Condition and one Owner. Renaming it to
-- `comms_condition_key` would have made it a column that exists on three panels
-- and is named after one of them, and would have rewritten data in a migration
-- for no gain the form can see.

-- ── #146. Five boxes on two inspection sheets ────────────────────────────────
--
-- Base Station prints a Time in its details block; `meganet.inspection` carried
-- the date of the visit and no clock reading. It is the one sheet of the six
-- with no data section, so there is no `inspection_data.at_time` to borrow —
-- which is why this is a column on the parent rather than a row underneath it.

alter table meganet.inspection
  add column if not exists inspected_at_time time;

comment on column meganet.inspection.inspected_at_time is
  'The Time box in the Base Station sheet''s details block (A18). A clock reading in a notebook, so `time` and not `timestamptz` — the same call 0009 made for meganet.inspection_data.at_time.';

-- The Mace sheet prints the DP voltage and the DP voltage under load twice over,
-- once for the existing battery and once for the replacement, beside the MACE
-- and PHONE readings that already have columns. The two sub-columns are headed
-- "DP" (Y21) and "DP (U/L)" (AC21); "Voltage (v)" is printed under each of them
-- twice, on the Existing Battery row (Y22, AC22) and the Replacement Battery row
-- (Y24, AC24). 0009 has `telephone_socket_v` for the PHONE reading and the four
-- MACE readings, and nothing for the DP pair.
--
-- Only the Mace sheet prints these, and that is the sheet's business rather than
-- the schema's: 0009 does not constrain which of `inspection_power`'s columns a
-- given configuration may fill, and inspections.js's `only: ['mace']` is what
-- decides they are offered on one sheet. Nullable, like every other reading on
-- this table, because a box nobody filled in is no row rather than a zero.

alter table meganet.inspection_power
  add column if not exists dp_existing_v               numeric,
  add column if not exists dp_existing_v_under_load    numeric,
  add column if not exists dp_replacement_v            numeric,
  add column if not exists dp_replacement_v_under_load numeric;

comment on column meganet.inspection_power.dp_existing_v is
  'Mace sheet, Existing Battery: the DP sub-column''s "Voltage (v)" (Y21/Y22). Beside the MACE reading in battery_existing_v, not instead of it.';
comment on column meganet.inspection_power.dp_existing_v_under_load is
  'Mace sheet, Existing Battery: the DP (U/L) sub-column''s "Voltage (v)" (AC21/AC22).';
comment on column meganet.inspection_power.dp_replacement_v is
  'Mace sheet, Replacement Battery: the DP sub-column''s "Voltage (v)" (Y24).';
comment on column meganet.inspection_power.dp_replacement_v_under_load is
  'Mace sheet, Replacement Battery: the DP (U/L) sub-column''s "Voltage (v)" (AC24).';

-- `meganet.save_inspection()` writes `meganet.inspection` with an explicit
-- column list, so the parent's new column needs it restated below. It needs no
-- change for the four power columns: `meganet.form_write()` reads a section
-- table's columns out of the catalogue at write time, which is exactly what
-- 0009's comment said it was built dynamic for. One of the two halves of this
-- migration is free and the other is not, and which is which was decided in
-- 0009 rather than here.

-- ── #148. Four boxes on the Council sheet's Comms and Power panel ────────────
--
-- The panel has three sub-columns — Comms (col U), Equipment (col Y), Power
-- (col AC) — and each prints its own Conditon (the sheet's spelling, row 10) and
-- its own Owner (row 12). Six boxes; 0009 held two. The existing
-- `condition_key` / `owner_key` pair stays as the Comms sub-column's, so these
-- four are the other two thirds.
--
-- Same references and same nullability as the pair they join: a rating nobody
-- circled is null, which on this form is the common state of all six.

alter table meganet.maintenance_asset
  add column if not exists equipment_condition_key text references meganet.condition_rating (key),
  add column if not exists equipment_owner_key     text references meganet.asset_owner (key),
  add column if not exists power_condition_key     text references meganet.condition_rating (key),
  add column if not exists power_owner_key         text references meganet.asset_owner (key);

comment on column meganet.maintenance_asset.condition_key is
  'On the rainfall and water-level panels, the panel''s Conditon box. On the comms panel it is the Comms sub-column''s (U11) — Equipment''s and Power''s are the two columns below. #148.';
comment on column meganet.maintenance_asset.owner_key is
  'On the rainfall and water-level panels, the panel''s Owner box. On the comms panel it is the Comms sub-column''s (U13). #148.';
comment on column meganet.maintenance_asset.equipment_condition_key is
  'Council sheet, Comms and Power panel, Equipment sub-column: "Conditon" (Y11). Comms and Power panel only.';
comment on column meganet.maintenance_asset.equipment_owner_key is
  'Council sheet, Comms and Power panel, Equipment sub-column: "Owner" (Y13). Comms and Power panel only.';
comment on column meganet.maintenance_asset.power_condition_key is
  'Council sheet, Comms and Power panel, Power sub-column: "Conditon" (AC11). Comms and Power panel only.';
comment on column meganet.maintenance_asset.power_owner_key is
  'Council sheet, Comms and Power panel, Power sub-column: "Owner" (AC13). Comms and Power panel only.';

-- The panel constraint, extended. 0009's version named the three boxes only the
-- comms panel prints; these four are four more of them, and a rainfall row
-- carrying an Equipment condition is the same mistake as one carrying a comms
-- method. Dropped and recreated rather than added alongside, so there is one
-- constraint saying one thing about this panel rather than two that have to be
-- read together — and so the name in an error message still points at the whole
-- rule.
--
-- `not valid` is deliberately not used: the four columns were created null a few
-- statements ago, so every existing row already satisfies this and the table
-- scan is over rows that cannot fail it.

alter table meganet.maintenance_asset
  drop constraint if exists maintenance_asset_comms_only_on_comms_panel;

alter table meganet.maintenance_asset
  add constraint maintenance_asset_comms_only_on_comms_panel check (
    asset = 'comms_power'
    or (comms_method_key is null and comms_equipment_key is null and power_key is null
        and equipment_condition_key is null and equipment_owner_key is null
        and power_condition_key is null and power_owner_key is null));

-- `meganet.save_maintenance_activity()` needs no change at all: it writes every
-- asset row through `meganet.form_write()`, so the four columns are writable the
-- moment they exist. #148's whole cost on this side is the four `alter`s and the
-- constraint.

-- ── The save function, restated for one column ───────────────────────────────
--
-- Unchanged from 0009 apart from `inspected_at_time` in three places: the insert
-- column list, the values list, and the `on conflict do update set` list. The
-- 409 stamp contract, the child-replacement order and the pruning behaviour are
-- all exactly as 0009 wrote them.

create or replace function meganet.save_inspection(
         p_doc jsonb,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid := nullif(p_doc ->> 'id', '')::uuid;
  v_actor   text := meganet.actor();
  v_is_new  boolean;
  v_prev    timestamptz;
  v_phase   text;
  v_item    jsonb;
  v_key     jsonb;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write inspections'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  if coalesce(p_doc ->> 'config_key', '') = '' then
    raise exception 'an inspection needs a config_key — one of the six station configurations'
      using errcode = '22023';
  end if;
  if nullif(p_doc ->> 'inspected_on', '') is null then
    raise exception 'an inspection needs the date it was carried out' using errcode = '22023';
  end if;

  if v_id is null then
    v_is_new := true;
    v_id := pg_catalog.gen_random_uuid();
    if p_expected_updated_at is not null then
      raise exception 'a new inspection cannot have been changed by anyone else'
        using errcode = 'PT409';
    end if;
  else
    select updated_at into v_prev from meganet.inspection where id = v_id for update;
    v_is_new := not found;
    if v_is_new and p_expected_updated_at is not null then
      raise exception 'inspection % is no longer in the database — it was deleted while you had it open', v_id
        using errcode = 'PT409',
              hint    = 'your entries are still on screen; copy anything you need, then reload';
    end if;
    if not v_is_new then
      if p_expected_updated_at is null then
        raise exception 'this form did not load inspection % from the database, so it will not overwrite it', v_id
          using errcode = 'PT409',
                hint    = 'reload and open the inspection again';
      end if;
      if v_prev is distinct from p_expected_updated_at then
        raise exception 'inspection % was changed in the database at %, after you opened it', v_id, v_prev
          using errcode = 'PT409',
                hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
      end if;
    end if;
  end if;

  insert into meganet.inspection (
      id, station_id, config_key, station_name, cbm_no, alert_id, lat, lon,
      inspected_on, inspected_at_time, inspector, office_last_visit, office_stock_changes,
      rain_gauge_type, rain_gauge_serial, remarks, next_visit_comments,
      origin, source_ref, updated_by)
  values (
      v_id,
      nullif(p_doc ->> 'station_id', ''),
      p_doc ->> 'config_key',
      coalesce(p_doc ->> 'station_name', ''),
      coalesce(p_doc ->> 'cbm_no', ''),
      (nullif(p_doc ->> 'alert_id', ''))::integer,
      (nullif(p_doc ->> 'lat', ''))::numeric,
      (nullif(p_doc ->> 'lon', ''))::numeric,
      (p_doc ->> 'inspected_on')::date,
      (nullif(p_doc ->> 'inspected_at_time', ''))::time,
      coalesce(p_doc ->> 'inspector', ''),
      (nullif(p_doc ->> 'office_last_visit', ''))::boolean,
      (nullif(p_doc ->> 'office_stock_changes', ''))::boolean,
      coalesce(p_doc ->> 'rain_gauge_type', ''),
      coalesce(p_doc ->> 'rain_gauge_serial', ''),
      coalesce(p_doc ->> 'remarks', ''),
      coalesce(p_doc ->> 'next_visit_comments', ''),
      coalesce(nullif(p_doc ->> 'origin', ''), 'form'),
      nullif(p_doc ->> 'source_ref', ''),
      v_actor)
  on conflict (id) do update set
      station_id = excluded.station_id,
      config_key = excluded.config_key,
      station_name = excluded.station_name,
      cbm_no = excluded.cbm_no,
      alert_id = excluded.alert_id,
      lat = excluded.lat,
      lon = excluded.lon,
      inspected_on = excluded.inspected_on,
      inspected_at_time = excluded.inspected_at_time,
      inspector = excluded.inspector,
      office_last_visit = excluded.office_last_visit,
      office_stock_changes = excluded.office_stock_changes,
      rain_gauge_type = excluded.rain_gauge_type,
      rain_gauge_serial = excluded.rain_gauge_serial,
      remarks = excluded.remarks,
      next_visit_comments = excluded.next_visit_comments,
      origin = excluded.origin,
      source_ref = excluded.source_ref,
      deleted_at = null,
      updated_by = excluded.updated_by;

  -- Children, replaced. Order matters in one place only: inspection_data_value
  -- hangs off inspection_data, so the delete goes the other way round and the
  -- insert follows the parent.
  delete from meganet.inspection_data_value   where inspection_id = v_id;
  delete from meganet.inspection_data         where inspection_id = v_id;
  delete from meganet.inspection_serial       where inspection_id = v_id;
  delete from meganet.inspection_power        where inspection_id = v_id;
  delete from meganet.inspection_rain_gauge   where inspection_id = v_id;
  delete from meganet.inspection_water_level  where inspection_id = v_id;
  delete from meganet.inspection_gas          where inspection_id = v_id;
  delete from meganet.inspection_radio        where inspection_id = v_id;
  delete from meganet.inspection_fade_margin  where inspection_id = v_id;
  delete from meganet.inspection_calibration  where inspection_id = v_id;
  delete from meganet.inspection_data_quality where inspection_id = v_id;
  delete from meganet.inspection_admin        where inspection_id = v_id;

  v_key := pg_catalog.jsonb_build_object('inspection_id', v_id);

  for v_item in
    select value from pg_catalog.jsonb_array_elements(coalesce(nullif(p_doc -> 'serials', 'null'::jsonb), '[]'::jsonb))
  loop
    perform meganet.form_write('inspection_serial', v_item || v_key);
  end loop;

  for v_phase, v_item in
    select key, value from pg_catalog.jsonb_each(coalesce(nullif(p_doc -> 'data', 'null'::jsonb), '{}'::jsonb))
     where pg_catalog.jsonb_typeof(value) = 'object'
  loop
    perform meganet.form_write('inspection_data',
      (v_item - 'values') || v_key || pg_catalog.jsonb_build_object('phase', v_phase));
    perform meganet.form_write('inspection_data_value',
      value || v_key || pg_catalog.jsonb_build_object('phase', v_phase))
      from pg_catalog.jsonb_array_elements(coalesce(nullif(v_item -> 'values', 'null'::jsonb), '[]'::jsonb));
  end loop;

  if pg_catalog.jsonb_typeof(p_doc -> 'power') = 'object'       then perform meganet.form_write('inspection_power',       (p_doc -> 'power') || v_key);       end if;
  if pg_catalog.jsonb_typeof(p_doc -> 'rain_gauge') = 'object'  then perform meganet.form_write('inspection_rain_gauge',  (p_doc -> 'rain_gauge') || v_key);  end if;
  if pg_catalog.jsonb_typeof(p_doc -> 'water_level') = 'object' then perform meganet.form_write('inspection_water_level', (p_doc -> 'water_level') || v_key); end if;
  if pg_catalog.jsonb_typeof(p_doc -> 'gas') = 'object'         then perform meganet.form_write('inspection_gas',         (p_doc -> 'gas') || v_key);         end if;
  if pg_catalog.jsonb_typeof(p_doc -> 'radio') = 'object'       then perform meganet.form_write('inspection_radio',       (p_doc -> 'radio') || v_key);       end if;
  if pg_catalog.jsonb_typeof(p_doc -> 'admin') = 'object'       then perform meganet.form_write('inspection_admin',       (p_doc -> 'admin') || v_key);       end if;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(coalesce(nullif(p_doc -> 'fade_margin', 'null'::jsonb), '[]'::jsonb))
  loop
    perform meganet.form_write('inspection_fade_margin', v_item || v_key);
  end loop;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(coalesce(nullif(p_doc -> 'calibrations', 'null'::jsonb), '[]'::jsonb))
  loop
    perform meganet.form_write('inspection_calibration', v_item || v_key);
  end loop;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(coalesce(nullif(p_doc -> 'data_quality', 'null'::jsonb), '[]'::jsonb))
  loop
    perform meganet.form_write('inspection_data_quality', v_item || v_key);
  end loop;

  return meganet.inspection_doc(v_id);
end;
$$;

comment on function meganet.save_inspection(jsonb, timestamptz) is
  'Insert or update one inspection and every section hanging off it, in one transaction. Children are replaced, not merged. Refuses a stale write with SQLSTATE PT409 (HTTP 409). Returns the saved document.';

-- `meganet.inspection_doc()` needs no change: it builds the parent half of the
-- document with `to_jsonb(i)`, so `inspected_at_time` is on the document the
-- moment the column exists. The four power columns and the four asset columns
-- arrive the same way, through `to_jsonb(x)` on their own tables.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping schema reload.';
    return;
  end if;
  -- New columns on tables PostgREST already knows about. Nothing here grants a
  -- privilege — the grants 0009 wrote are per table, not per column, so the nine
  -- columns inherit them — but PostgREST caches the column list, and a cache
  -- that predates this file would refuse `inspected_at_time` as an unknown one.
  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '11')
on conflict (key) do update set value = excluded.value;
