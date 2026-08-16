-- check_inspections.sql — Prove the inspection schema, against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_inspections.sql
--
-- Every check below is one line of #115's acceptance, or one claim the head of
-- 0009_inspections.sql makes. The whole script runs inside a transaction and
-- rolls back, so it is safe against the live database: nothing it writes
-- survives, including the placeholder stations it needs to hang inspections off.
--
-- It needs to be run as a role meganet.is_editor() says yes to — a direct psql
-- connection, or one holding the service key. It prints a row per check and
-- exits non-zero if any of them failed, so it works in a workflow as well as by
-- hand.
--
-- Run it after applying 0009, and again after touching anything in it.

\set ON_ERROR_STOP on

begin;

create temporary table _check (
  ord   serial,
  name  text,
  ok    boolean,
  note  text
) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

-- Did this statement raise, and with which SQLSTATE? Half the checks below are
-- about a refusal, and a refusal is only worth anything if it is the *right*
-- refusal.
create or replace function pg_temp.raises(p_sql text, p_sqlstate text default null)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return p_sqlstate is null or sqlstate = p_sqlstate;
end;
$$;

-- The labels transcribed off the `Dropdown` sheet, so that the check is against
-- the spreadsheet rather than against 0009 restating itself.
create or replace function pg_temp.list_is(p_table text, p_expected text[])
returns boolean language plpgsql as $$
declare
  v_got text[];
begin
  execute pg_catalog.format(
    'select array_agg(label order by ord) from meganet.%I', p_table) into v_got;
  return v_got = p_expected;
end;
$$;

-- Somewhere to hang the fixtures. Rolled back either way; the ids are prefixed
-- so a half-committed accident is obvious.
insert into meganet.rm_system (id, ord, name)
values (-981, -981, 'check_inspections placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id)
values ('_check_insp_alert', -981, 'Check Alert Site', '998001', -981),
       ('_check_insp_base',  -982, 'Check Base Station', '998002', -981)
on conflict (id) do nothing;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
declare
  v_tables text[] := array[
    'rain_instrument_type', 'condition_rating', 'asset_owner', 'wl_instrument_type',
    'comms_method', 'comms_equipment', 'power_supply', 'yes_no', 'data_quality_rating',
    'council', 'equipment_kind', 'attachment_role',
    'inspection_config', 'inspection_section', 'inspection_config_section',
    'calibration_kind',
    'inspection', 'inspection_serial', 'inspection_data', 'inspection_data_value',
    'inspection_power', 'inspection_rain_gauge', 'inspection_water_level',
    'inspection_gas', 'inspection_radio', 'inspection_fade_margin',
    'inspection_calibration', 'inspection_data_quality', 'inspection_admin',
    'maintenance_activity', 'maintenance_asset', 'maintenance_data_quality',
    'attachment'];
begin
  -- At least 9, for the same reason check_ingest.sql says at least 6: a database
  -- carrying a later migration still carries this one.
  perform pg_temp.check_that('schema_version is at least 9',
    (select value::integer >= 9 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('every table 0009 creates exists',
    (select count(*) = array_length(v_tables, 1) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r' and c.relname = any(v_tables)),
    (select string_agg(t, ', ') from unnest(v_tables) t
      where to_regclass('meganet.' || t) is null));

  perform pg_temp.check_that('RLS is on for every table 0009 creates',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relname = any(v_tables)),
    'db/README.md: no table without RLS, in the same file');

  perform pg_temp.check_that('every table 0009 creates has at least one policy',
    (select bool_and(n > 0) from (
       select count(p.polname) as n from unnest(v_tables) t
         left join pg_catalog.pg_policy p on p.polrelid = ('meganet.' || t)::regclass
        group by t) s));

  perform pg_temp.check_that('both views exist',
    to_regclass('meganet.inspection_form') is not null
    and to_regclass('meganet.inspection_needs_maintenance') is not null);
end
$$;

-- ── 2. The Dropdown sheet, verbatim ──────────────────────────────────────────
-- Acceptance: "Every Dropdown sheet list is a real lookup table/enum with the
-- exact values transcribed, not a re-invented set." The arrays below are the
-- spreadsheet's columns A-L, trimmed of the trailing spaces and non-breaking
-- spaces the cells carry and nothing else.

do $$
begin
  perform pg_temp.check_that('column A — instrument type, rainfall',
    pg_temp.list_is('rain_instrument_type',
      array['TBRG 0.2mm', 'TBRG 0.5mm', 'TBRG 1 mm', 'Other']));

  perform pg_temp.check_that('column B — condition',
    pg_temp.list_is('condition_rating',
      array['Good', 'Fair', 'Poor (add comments below)']));

  perform pg_temp.check_that('column C — owner',
    pg_temp.list_is('asset_owner', array['Council', 'Bureau', 'Unknown']));

  perform pg_temp.check_that('column D — WL instrument type',
    pg_temp.list_is('wl_instrument_type',
      array['OTT', 'HS40', 'Amazon', 'Nitrogen', 'Water Log', 'HS40 compact']));

  perform pg_temp.check_that('column E — comms method',
    pg_temp.list_is('comms_method', array['Alert1', 'Satellite', 'Cellular', 'Other']));

  perform pg_temp.check_that('column F — comms equipment',
    pg_temp.list_is('comms_equipment', array['ELPROV3', 'Campbells Logger', 'Other']));

  perform pg_temp.check_that('column H — power',
    pg_temp.list_is('power_supply', array['Mains', 'Solar and Battery']));

  perform pg_temp.check_that('column I — yes/no',
    pg_temp.list_is('yes_no', array['Yes', 'No']));

  perform pg_temp.check_that('column J — data quality rating',
    pg_temp.list_is('data_quality_rating',
      array['Missing Record', 'Non verified', 'Poor Quality', 'Fair Quality', 'Good Quality']));

  perform pg_temp.check_that('column L — the 22 councils, in sheet order',
    pg_temp.list_is('council', array[
      'Bundaberg', 'Burdekin', 'Cairns', 'Cassowary Coast', 'Central Highlands',
      'Fraser Coast', 'Gladstone', 'Gold Coast', 'Goondiwindi', 'Hinchinbrook',
      'Logan', 'Mackay', 'Moreton Bay', 'Murweh', 'Noosa', 'Rockhampton',
      'Scenic Rim', 'Southern Downs', 'Sunshine Coast', 'Townsville',
      'Western Downs', 'Whitsunday']));

  perform pg_temp.check_that('no label carries a stray space or non-breaking space',
    (select bool_and(label = btrim(label, E'  ')) from (
       select label from meganet.rain_instrument_type
       union all select label from meganet.condition_rating
       union all select label from meganet.asset_owner
       union all select label from meganet.wl_instrument_type
       union all select label from meganet.comms_method
       union all select label from meganet.comms_equipment
       union all select label from meganet.power_supply
       union all select label from meganet.yes_no
       union all select label from meganet.data_quality_rating
       union all select label from meganet.council) s),
    'a label ending in U+00A0 is one nobody can match by typing');

  perform pg_temp.check_that('two ratings ask for a maintenance form',
    (select array_agg(key order by ord) from meganet.data_quality_rating
      where needs_maintenance) = array['missing_record', 'poor_quality'],
    'the printed instruction says "poor or have issues"');
end
$$;

-- ── 3. The form matrix matches the sheets ────────────────────────────────────
-- Acceptance: every field in the core sections and per-type deltas has a home,
-- or an explicit "not applicable for this configuration". These are the facts
-- that were read off the six sheets cell by cell, including the four places a
-- prose summary of the workbook had them differently.

do $$
begin
  perform pg_temp.check_that('six configurations, one per sheet',
    (select count(*) = 6 from meganet.inspection_config)
    and (select bool_and(sheet <> '') from meganet.inspection_config));

  perform pg_temp.check_that('fourteen sections, every one used by at least one form',
    (select count(*) = 14 from meganet.inspection_section)
    and not exists (select 1 from meganet.inspection_section s
                     where not exists (select 1 from meganet.inspection_config_section cs
                                        where cs.section_key = s.key)));

  perform pg_temp.check_that('every configuration prints details and remarks',
    (select count(*) = 6 from meganet.inspection_config c
      where exists (select 1 from meganet.inspection_config_section cs
                     where cs.config_key = c.key and cs.section_key = 'station_details')
        and exists (select 1 from meganet.inspection_config_section cs
                     where cs.config_key = c.key and cs.section_key = 'remarks')));

  -- `printed` throughout this block: 0014 added retired sections to the matrix
  -- so that an imported 1990s row can carry a block the current sheet dropped.
  -- What each form *prints* is the claim these checks are about, and it is
  -- unchanged.
  perform pg_temp.check_that('only Alert and Base Station print a radio section',
    (select array_agg(config_key order by config_key) from meganet.inspection_config_section
      where section_key = 'radio' and printed) = array['alert', 'base_station'],
    'Campbell reports to a base station; Mace is telephone; the old logger sheet prints no antenna block');

  perform pg_temp.check_that('only Alert and Campbell have a data-quality block',
    (select array_agg(config_key order by config_key) from meganet.inspection_config_section
      where section_key = 'data_quality') = array['alert', 'campbell_datalogger']);

  perform pg_temp.check_that('only Alert, Campbell and Base Station have a photo checklist',
    (select array_agg(config_key order by config_key) from meganet.inspection_config_section
      where section_key = 'admin_checklist')
      = array['alert', 'base_station', 'campbell_datalogger']);

  perform pg_temp.check_that('Gas Only prints exactly five sections',
    (select array_agg(section_key order by ord) from meganet.inspection_config_section
      where config_key = 'gas_only')
      = array['station_details', 'serial_numbers', 'gas', 'water_level', 'remarks']);

  perform pg_temp.check_that('Base Station is the only form printing decoder/receiver tests',
    (select array_agg(config_key) from meganet.inspection_config_section
      where section_key = 'base_tests' and printed) = array['base_station']);

  perform pg_temp.check_that('Gas Only''s water-level section says it is one printed line',
    (select variant_note like '%Staff Gauge%' from meganet.inspection_config_section
      where config_key = 'gas_only' and section_key = 'water_level'));

  perform pg_temp.check_that('every section names a table that exists',
    (select bool_and(home = '' or to_regclass('meganet.' || home) is not null)
       from meganet.inspection_section));

  perform pg_temp.check_that('every calibration kind prints under a section some form has',
    not exists (select 1 from meganet.calibration_kind k
                 where not exists (select 1 from meganet.inspection_config_section cs
                                    where cs.section_key = k.section_key)));
end
$$;

-- ── 4. "Not applicable" is enforced, not documented ──────────────────────────
-- Decision 2 at the head of 0009. This is the check that the distinction between
-- "this station has no gas bubbler" and "nobody filled the gas section in" is
-- one the database holds.

do $$
declare
  v_alert uuid;
  v_base  uuid;
begin
  insert into meganet.inspection (station_id, config_key, station_name, inspected_on, inspector)
  values ('_check_insp_alert', 'alert', 'Check Alert Site', current_date, 'CI')
  returning id into v_alert;

  insert into meganet.inspection (station_id, config_key, station_name, inspected_on, inspector)
  values ('_check_insp_base', 'base_station', 'Check Base Station', current_date, 'CI')
  returning id into v_base;

  perform pg_temp.check_that('an Alert inspection accepts a gas section',
    not pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_gas (inspection_id, existing_cylinder_pressure_kpa)
       values (%L, 12000)', v_alert)));

  perform pg_temp.check_that('a Base Station inspection refuses a gas section',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_gas (inspection_id, existing_cylinder_pressure_kpa)
       values (%L, 12000)', v_base), '22023'),
    'the base-station sheet has no gas banner');

  perform pg_temp.check_that('a Base Station inspection refuses a data-quality row',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_data_quality (inspection_id, parameter, on_departure_key)
       values (%L, ''rain'', ''good_quality'')', v_base), '22023'));

  perform pg_temp.check_that('a Base Station inspection accepts its antenna tests',
    not pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_radio (inspection_id, tx_size_w, existing_frequency_mhz)
       values (%L, 5, 151.5)', v_base)));

  -- The calibration guard, whose section comes from the kind rather than the
  -- table, so it is a separate trigger and needs its own check.
  perform pg_temp.check_that('a decoder test belongs to a Base Station inspection',
    not pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_calibration (inspection_id, kind_key, expected_result, measured)
       values (%L, ''decoder_test'', 24.0, 23.4)', v_base)));

  perform pg_temp.check_that('a decoder test does not belong to an Alert inspection',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_calibration (inspection_id, kind_key, expected_result, measured)
       values (%L, ''decoder_test'', 24.0, 23.4)', v_alert), '22023'));

  perform pg_temp.check_that('a Base Station inspection has no rain tip test to record',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.inspection_calibration (inspection_id, kind_key, ord, pct_error)
       values (%L, ''rain_tip_test'', 1, 2.1)', v_base), '22023'));

  -- The three tip-test checks the 6% rule is read across, and the rule itself.
  insert into meganet.inspection_calibration (inspection_id, kind_key, ord, expected_result, result, pct_error)
  values (v_alert, 'rain_tip_test', 1, 20.2, 20.0, 0.99),
         (v_alert, 'rain_tip_test', 2, 20.2, 19.1, 5.45),
         (v_alert, 'rain_tip_test', 3, 20.2, 18.4, 8.91);

  insert into meganet.inspection_rain_gauge (inspection_id, mean_pct_error, gauge_level)
  values (v_alert, 5.12, true);

  perform pg_temp.check_that('5.12%% mean error does not call for an adjustment',
    (select adjustment_indicated = false from meganet.inspection_rain_gauge
      where inspection_id = v_alert));

  update meganet.inspection_rain_gauge set mean_pct_error = 6.4 where inspection_id = v_alert;

  perform pg_temp.check_that('6.4%% mean error does — the sheet''s printed rule, computed',
    (select adjustment_indicated from meganet.inspection_rain_gauge
      where inspection_id = v_alert));

  perform pg_temp.check_that('the threshold is per visit, not a constant in code',
    (select adjustment_threshold_pct = 6 from meganet.inspection_rain_gauge
      where inspection_id = v_alert));

  -- The SWR legend printed beside the box on the Alert sheet.
  insert into meganet.inspection_radio (inspection_id, existing_swr) values (v_alert, 1.3);
  perform pg_temp.check_that('SWR 1.3 reads as good',
    (select swr_rating = 'good' from meganet.inspection_radio where inspection_id = v_alert));
  update meganet.inspection_radio set existing_swr = 1.9 where inspection_id = v_alert;
  perform pg_temp.check_that('SWR 1.9 reads as fair',
    (select swr_rating = 'fair' from meganet.inspection_radio where inspection_id = v_alert));
  update meganet.inspection_radio set existing_swr = 2.4 where inspection_id = v_alert;
  perform pg_temp.check_that('SWR 2.4 reads as poor',
    (select swr_rating = 'poor' from meganet.inspection_radio where inspection_id = v_alert));

  delete from meganet.inspection where id in (v_alert, v_base);
end
$$;

-- ── 5. Writing a whole visit ─────────────────────────────────────────────────
-- Acceptance: a migration exists and applies cleanly, and the record round-trips.
-- The contract is 0004's: one call is one transaction, children are replaced
-- rather than merged, and a stale write is refused with PT409.

do $$
declare
  v_doc   jsonb;
  v_id      uuid;
  v_stamp   timestamptz;
  v_deleted boolean;
begin
  v_doc := meganet.save_inspection(jsonb_build_object(
    'station_id',   '_check_insp_alert',
    'config_key',   'alert',
    'station_name', 'Check Alert Site',
    'cbm_no',       '998001',
    'inspected_on', current_date::text,
    'inspector',    'CI',
    'remarks',      'written by tools/check_inspections.sql',
    'serials', jsonb_build_array(
      jsonb_build_object('ord', 1, 'equipment_key', 'canister', 'serial_no', 'C-1234', 'version', '3.2'),
      jsonb_build_object('ord', 2, 'equipment_key', 'tbrg',     'serial_no', 'T-9876')),
    'data', jsonb_build_object(
      'initial', jsonb_build_object('at_time', '08:15', 'rain_logger', 12.4, 'battery_v', 13.1,
                  'values', jsonb_build_array(
                    jsonb_build_object('ord', 1, 'alert_id', 6128, 'accumulator', 4021))),
      'final',   jsonb_build_object('at_time', '10:40', 'rain_logger', 12.4, 'battery_v', 13.4,
                  'logger_cleared', true, 'values', '[]'::jsonb)),
    'power',      jsonb_build_object('battery_existing_v', 13.1, 'weather_note', 'overcast'),
    'rain_gauge', jsonb_build_object('gauge_level', true, 'mean_pct_error', 2.2),
    'gas',        jsonb_build_object('existing_cylinder_pressure_kpa', 11500, 'system_purged', true),
    'radio',      jsonb_build_object('tx_size_w', 5, 'existing_swr', 1.4),
    'fade_margin', jsonb_build_array(
      jsonb_build_object('phase', 'original',   'ord', 1, 'load_db', 12, 'tips', 3),
      jsonb_build_object('phase', 'this_visit', 'ord', 1, 'load_db', 15, 'tips', 4)),
    'calibrations', jsonb_build_array(
      jsonb_build_object('kind_key', 'druck', 'error_m', 0.004),
      jsonb_build_object('kind_key', 'rain_tip_test', 'ord', 1, 'pct_error', 2.2)),
    'data_quality', jsonb_build_array(
      jsonb_build_object('parameter', 'rain',        'on_arrival_key', 'good_quality', 'on_departure_key', 'good_quality'),
      jsonb_build_object('parameter', 'water_level', 'on_arrival_key', 'non_verified', 'on_departure_key', 'poor_quality')),
    'admin', jsonb_build_object('photos_taken', true, 'on_web', false)));

  v_id := (v_doc ->> 'id')::uuid;
  v_stamp := (v_doc ->> 'updated_at')::timestamptz;

  perform pg_temp.check_that('save_inspection() returns the saved document',
    v_id is not null and (v_doc ->> 'config_key') = 'alert');

  perform pg_temp.check_that('every section came back on the document',
    (v_doc -> 'serials') is not null
    and jsonb_array_length(v_doc -> 'serials') = 2
    and (v_doc -> 'data' -> 'initial' ->> 'rain_logger')::numeric = 12.4
    and jsonb_array_length(v_doc -> 'data' -> 'initial' -> 'values') = 1
    and (v_doc -> 'power' ->> 'weather_note') = 'overcast'
    and (v_doc -> 'radio' ->> 'swr_rating') = 'good'
    and jsonb_array_length(v_doc -> 'fade_margin') = 2
    and jsonb_array_length(v_doc -> 'calibrations') = 2
    and jsonb_array_length(v_doc -> 'data_quality') = 2,
    v_doc::text);

  perform pg_temp.check_that('updated_by is stamped server-side',
    (select updated_by is not null from meganet.inspection where id = v_id));

  perform pg_temp.check_that('inspection_doc() and the save agree',
    meganet.inspection_doc(v_id) = v_doc);

  -- Children are replaced. The second save names one serial number, so the
  -- record must end with one — a merge would leave the deleted row behind, and
  -- "I removed that row" would be unsayable.
  v_doc := meganet.save_inspection(
    (v_doc - 'serials') || jsonb_build_object('serials', jsonb_build_array(
      jsonb_build_object('ord', 1, 'equipment_key', 'canister', 'serial_no', 'C-1234', 'version', '3.3'))),
    v_stamp);

  perform pg_temp.check_that('children are replaced, not merged',
    jsonb_array_length(v_doc -> 'serials') = 1
    and (v_doc -> 'serials' -> 0 ->> 'version') = '3.3');

  perform pg_temp.check_that('a save with the stamp it loaded is accepted',
    (v_doc ->> 'updated_at')::timestamptz >= v_stamp);

  -- The stamp has to be made stale by hand. `now()` is the *transaction's* clock
  -- and this whole script is one transaction, so every save in it writes the
  -- same updated_at and no amount of saving produces a genuinely moved stamp. A
  -- stamp an hour old is the same thing from the function's point of view: it is
  -- not the one the row carries.
  perform pg_temp.check_that('a stale write is refused with PT409',
    pg_temp.raises(pg_catalog.format(
      'select meganet.save_inspection(%L::jsonb, %L::timestamptz)',
      v_doc::text, v_stamp - interval '1 hour'), 'PT409'),
    'saving against a version somebody else has moved past would overwrite their work');

  perform pg_temp.check_that('a save with no stamp at all is refused with PT409',
    pg_temp.raises(pg_catalog.format(
      'select meganet.save_inspection(%L::jsonb)', v_doc::text), 'PT409'),
    'an editor that cannot say which version it started from has no business overwriting one');

  perform pg_temp.check_that('an inspection with no config_key is refused',
    pg_temp.raises(
      'select meganet.save_inspection(''{"inspected_on":"2026-01-01"}''::jsonb)', '22023'));

  perform pg_temp.check_that('an inspection with no date is refused',
    pg_temp.raises(
      'select meganet.save_inspection(''{"config_key":"alert"}''::jsonb)', '22023'));

  perform pg_temp.check_that('save_inspection() refuses a section the form does not print',
    pg_temp.raises(
      'select meganet.save_inspection(''{"config_key":"base_station","inspected_on":"2026-01-01",
         "gas":{"existing_cylinder_pressure_kpa":1}}''::jsonb)', '22023'),
    'the guard is a trigger, so it fires inside the save as well as outside it');

  -- Decision 5: the printed cross-reference, as a foreign key.
  perform pg_temp.check_that('a poor departure rating shows up as needing maintenance',
    (select not has_maintenance_activity from meganet.inspection_needs_maintenance
      where inspection_id = v_id and parameter = 'water_level'));

  perform pg_temp.check_that('a good departure rating does not',
    not exists (select 1 from meganet.inspection_needs_maintenance
                 where inspection_id = v_id and parameter = 'rain'));

  perform meganet.save_maintenance_activity(jsonb_build_object(
    'station_id',    '_check_insp_alert',
    'inspection_id', v_id::text,
    'visited_on',    current_date::text,
    'council_key',   'burdekin',
    'trigger_reason', 'poor_on_departure',
    'landowner_contact_name', 'A. Landowner',
    'assets', jsonb_build_array(
      jsonb_build_object('asset', 'rainfall',    'rain_instrument_type_key', 'tbrg_0_2mm',
                         'condition_key', 'fair', 'owner_key', 'council'),
      jsonb_build_object('asset', 'comms_power', 'comms_method_key', 'alert1',
                         'comms_equipment_key', 'elpro_v3', 'power_key', 'solar_battery')),
    'data_quality', jsonb_build_array(
      jsonb_build_object('parameter', 'river_level', 'on_departure_key', 'good_quality'))));

  perform pg_temp.check_that('linking a maintenance activity closes the loop',
    (select has_maintenance_activity from meganet.inspection_needs_maintenance
      where inspection_id = v_id and parameter = 'water_level'),
    'the sentence printed at the foot of every sheet, answered');

  perform pg_temp.check_that('a rainfall panel cannot carry a comms method',
    pg_temp.raises(
      (select pg_catalog.format(
         'insert into meganet.maintenance_asset (activity_id, asset, comms_method_key)
          values (%L, ''water_level'', ''alert1'')', m.id)
         from meganet.maintenance_activity m where m.inspection_id = v_id limit 1), '23514'));

  perform pg_temp.check_that('a water-level panel cannot carry a rain instrument type',
    pg_temp.raises(
      (select pg_catalog.format(
         'update meganet.maintenance_asset set rain_instrument_type_key = ''tbrg_1mm''
           where activity_id = %L and asset = ''comms_power''', m.id)
         from meganet.maintenance_activity m where m.inspection_id = v_id limit 1), '23514'));

  -- Attachments: exactly one parent, and the object claimed once.
  perform pg_temp.check_that('an attachment belongs to exactly one record',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.attachment (inspection_id, storage_path) values (null, %L)',
      'orphan.jpg'), '23514'));

  insert into meganet.attachment (inspection_id, role_key, storage_path)
  values (v_id, 'canister_config', 'check/canister.png');

  perform pg_temp.check_that('the same stored object cannot be claimed twice',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.attachment (inspection_id, role_key, storage_path)
       values (%L, ''photo'', ''check/canister.png'')', v_id), '23505'));

  perform pg_temp.check_that('the attachment comes back on the document',
    jsonb_array_length(meganet.inspection_doc(v_id) -> 'attachments') = 1);

  -- Soft delete, as in 0004. One statement per step: Postgres does not promise
  -- to evaluate the operands of AND left to right, so a conjunction here would
  -- be a test that sometimes reads the row before it deletes it.
  v_deleted := meganet.delete_inspection(v_id);
  perform pg_temp.check_that('delete_inspection() is soft',
    v_deleted
    and (select deleted_at is not null from meganet.inspection where id = v_id)
    and meganet.inspection_doc(v_id) is null);

  update meganet.inspection set deleted_at = null where id = v_id;
  perform pg_temp.check_that('and one update brings it back',
    meganet.inspection_doc(v_id) is not null);
end
$$;

-- ── 5b. The nine boxes 0011 gave a column to ─────────────────────────────────
-- #146 (five boxes on two inspection sheets) and #148 (four on the Council
-- sheet's Comms and Power panel), both applied by
-- db/migrations/0011_printed_boxes.sql.
--
-- These are here rather than in a check script of their own because they are
-- nine columns on three tables this file already proves, and a second script
-- would have had to stand up the same fixtures to say less. It does mean this
-- file is no longer only about 0009 — which the section number says out loud.
--
-- The round-trips are the checks that matter. A column existing proves the
-- `alter` ran; a value going out through save_inspection() and coming back
-- through inspection_doc() proves the path a person uses works, and that is
-- where 0011's one non-mechanical change lives — meganet.inspection is written
-- with an explicit column list, so it had to be restated, and a restatement that
-- dropped a column would pass a catalogue check and fail here.

do $$
declare
  v_doc     jsonb;
  v_id      uuid;
  v_stamp   timestamptz;
  v_mace    jsonb;
  v_act     jsonb;
  v_act_id  uuid;
  v_missing text;
begin
  perform pg_temp.check_that('schema_version is at least 11',
    (select value::integer >= 11 from meganet.app_meta where key = 'schema_version'),
    'the app checks the same number — core.js DB_SCHEMA_VERSION');

  select string_agg(want.t || '.' || want.c, ', ') into v_missing
    from (values
      ('inspection',       'inspected_at_time',           'time without time zone'),
      ('inspection_power', 'dp_existing_v',               'numeric'),
      ('inspection_power', 'dp_existing_v_under_load',    'numeric'),
      ('inspection_power', 'dp_replacement_v',            'numeric'),
      ('inspection_power', 'dp_replacement_v_under_load', 'numeric'),
      ('maintenance_asset', 'equipment_condition_key',    'text'),
      ('maintenance_asset', 'equipment_owner_key',        'text'),
      ('maintenance_asset', 'power_condition_key',        'text'),
      ('maintenance_asset', 'power_owner_key',            'text')
    ) as want(t, c, ty)
   where not exists (
     select 1 from information_schema.columns col
      where col.table_schema = 'meganet' and col.table_name = want.t
        and col.column_name = want.c and col.data_type = want.ty);

  perform pg_temp.check_that('every column 0011 adds exists, with the type it was written as',
    v_missing is null, coalesce(v_missing, ''));

  -- The four new asset keys point at the same two vocabularies as the pair they
  -- join, so a rating that is not on the Dropdown sheet is refused here as it is
  -- there. Checked as foreign keys rather than as a check constraint listing
  -- values, which is what the rest of this schema does.
  perform pg_temp.check_that('the four new asset keys reference the vocabularies 0009 wrote',
    (select count(*) = 4 from pg_catalog.pg_constraint c
      where c.conrelid = 'meganet.maintenance_asset'::regclass and c.contype = 'f'
        and pg_catalog.pg_get_constraintdef(c.oid) = any(array[
          'FOREIGN KEY (equipment_condition_key) REFERENCES meganet.condition_rating(key)',
          'FOREIGN KEY (equipment_owner_key) REFERENCES meganet.asset_owner(key)',
          'FOREIGN KEY (power_condition_key) REFERENCES meganet.condition_rating(key)',
          'FOREIGN KEY (power_owner_key) REFERENCES meganet.asset_owner(key)'])),
    'a Condition against meganet.condition_rating and an Owner against meganet.asset_owner, like the pair they join');

  -- ── #146, round-tripped ────────────────────────────────────────────────────
  -- Two documents, because the five boxes are on two sheets and the section
  -- guard means that is not a detail: Base Station prints no battery section, so
  -- a document carrying the Time *and* the DP voltages is refused — which this
  -- section found by being written the other way round first.
  v_doc := meganet.save_inspection(jsonb_build_object(
    'station_id',        '_check_insp_base',
    'config_key',        'base_station',
    'station_name',      'Check Base Station',
    'inspected_on',      current_date::text,
    'inspected_at_time', '14:35',
    'inspector',         'CI',
    'remarks',           'written by tools/check_inspections.sql, 0011 section'));

  v_id    := (v_doc ->> 'id')::uuid;
  v_stamp := (v_doc ->> 'updated_at')::timestamptz;

  perform pg_temp.check_that('the Base Station Time survives a save and comes back on the document',
    (v_doc ->> 'inspected_at_time') = '14:35:00',
    coalesce(v_doc ->> 'inspected_at_time', 'null'));

  v_mace := meganet.save_inspection(jsonb_build_object(
    'station_id',   '_check_insp_alert',
    'config_key',   'mace',
    'station_name', 'Check Mace Site',
    'inspected_on', current_date::text,
    'remarks',      'written by tools/check_inspections.sql, 0011 section',
    'power', jsonb_build_object(
      'dp_existing_v',               12.7,
      'dp_existing_v_under_load',    12.1,
      'dp_replacement_v',            13.4,
      'dp_replacement_v_under_load', 13.0)));

  perform pg_temp.check_that('the four Mace DP voltages survive a save and come back',
    (v_mace -> 'power' ->> 'dp_existing_v')::numeric = 12.7
    and (v_mace -> 'power' ->> 'dp_existing_v_under_load')::numeric = 12.1
    and (v_mace -> 'power' ->> 'dp_replacement_v')::numeric = 13.4
    and (v_mace -> 'power' ->> 'dp_replacement_v_under_load')::numeric = 13.0,
    coalesce((v_mace -> 'power')::text, 'no power section'));

  perform meganet.delete_inspection((v_mace ->> 'id')::uuid);

  -- The one that would catch a restatement that lost the column: an update has
  -- its own column list in `on conflict do update set`, and a save that writes
  -- the time on insert and drops it on update is a bug nobody would see until
  -- the second save.
  v_doc := meganet.save_inspection(
    v_doc || jsonb_build_object('inspected_at_time', '16:05'), v_stamp);

  perform pg_temp.check_that('and a second save updates the Time rather than dropping it',
    (v_doc ->> 'inspected_at_time') = '16:05:00',
    coalesce(v_doc ->> 'inspected_at_time', 'null'));

  perform pg_temp.check_that('a Time nobody wrote down stays null',
    (select inspected_at_time is null from meganet.inspection
      where station_id = '_check_insp_alert' and deleted_at is null limit 1),
    'a blank box on paper is null, not midnight');

  perform meganet.delete_inspection(v_id);

  -- ── #148, round-tripped ────────────────────────────────────────────────────
  v_act := meganet.save_maintenance_activity(jsonb_build_object(
    'station_id', '_check_insp_alert',
    'visited_on', current_date::text,
    'assets', jsonb_build_array(
      jsonb_build_object('asset', 'comms_power',
        'comms_method_key',        'alert1',
        'condition_key',           'poor',
        'owner_key',               'council',
        'comms_equipment_key',     'elpro_v3',
        'equipment_condition_key', 'good',
        'equipment_owner_key',     'council',
        'power_key',               'solar_battery',
        'power_condition_key',     'good',
        'power_owner_key',         'council'))));

  v_act_id := (v_act ->> 'id')::uuid;

  -- The Mt Kanigan case, in the database: three sub-columns answered three ways.
  -- Before 0011 this document could only say "poor".
  perform pg_temp.check_that('the Comms and Power panel records its three Conditions separately',
    (select condition_key = 'poor' and equipment_condition_key = 'good'
        and power_condition_key = 'good'
       from meganet.maintenance_asset
      where activity_id = v_act_id and asset = 'comms_power'),
    'Comms poor, Equipment good, Power good — the filled Mt Kanigan sheet');

  perform pg_temp.check_that('and its three Owners',
    (select owner_key = 'council' and equipment_owner_key = 'council'
        and power_owner_key = 'council'
       from meganet.maintenance_asset
      where activity_id = v_act_id and asset = 'comms_power'));

  perform pg_temp.check_that('all four new asset keys come back on the document',
    (select elem -> 'equipment_condition_key' is not null
        and elem -> 'equipment_owner_key' is not null
        and elem -> 'power_condition_key' is not null
        and elem -> 'power_owner_key' is not null
       from jsonb_array_elements(v_act -> 'assets') elem
      where elem ->> 'asset' = 'comms_power'),
    'save_maintenance_activity() writes these through form_write(), so this is that claim checked');

  -- The extended constraint, one column at a time. A single insert carrying all
  -- four would pass this loop with three of the four unconstrained, which is the
  -- shape of bug that makes a green constraint check worthless.
  perform pg_temp.check_that(
    pg_catalog.format('a rainfall panel cannot carry %s', col),
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.maintenance_asset (activity_id, asset, %I)
       values (%L, ''rainfall'', ''good'')', col, v_act_id), '23514'))
    from unnest(array['equipment_condition_key', 'power_condition_key']) col;

  perform pg_temp.check_that(
    pg_catalog.format('a water-level panel cannot carry %s', col),
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.maintenance_asset (activity_id, asset, %I)
       values (%L, ''water_level'', ''council'')', col, v_act_id), '23514'))
    from unnest(array['equipment_owner_key', 'power_owner_key']) col;

  -- 0011 dropped and recreated the constraint rather than adding a second one,
  -- so the three keys 0009 named have to still be refused. A recreate that lost
  -- them would pass every check above.
  perform pg_temp.check_that('the constraint 0011 recreated still refuses the three keys 0009 named',
    pg_temp.raises(pg_catalog.format(
      'insert into meganet.maintenance_asset (activity_id, asset, comms_equipment_key)
       values (%L, ''rainfall'', ''elpro_v3'')', v_act_id), '23514'));

  perform meganet.delete_maintenance_activity(v_act_id);
end
$$;

-- ── 6. Nothing here is readable with the anon key ────────────────────────────
-- The security decision at the head of 0009: the vocabularies are public, the
-- records are not. Checked as grants rather than by reasoning about them, and
-- checked for both halves — a schema that refuses the wrong things is as broken
-- as one that permits them.

do $$
declare
  v_public text[] := array[
    'rain_instrument_type', 'condition_rating', 'asset_owner', 'wl_instrument_type',
    'comms_method', 'comms_equipment', 'power_supply', 'yes_no', 'data_quality_rating',
    'council', 'equipment_kind', 'attachment_role', 'inspection_config',
    'inspection_section', 'inspection_config_section', 'calibration_kind'];
  v_private text[] := array[
    'inspection', 'inspection_serial', 'inspection_data', 'inspection_data_value',
    'inspection_power', 'inspection_rain_gauge', 'inspection_water_level',
    'inspection_gas', 'inspection_radio', 'inspection_fade_margin',
    'inspection_calibration', 'inspection_data_quality', 'inspection_admin',
    'maintenance_activity', 'maintenance_asset', 'maintenance_data_quality', 'attachment'];
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('no anon role — grant checks skipped', true,
      'not a Supabase project');
    return;
  end if;

  perform pg_temp.check_that('anon may read every vocabulary',
    (select bool_and(has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(v_public) t),
    (select string_agg(t, ', ') from unnest(v_public) t
      where not has_table_privilege('anon', 'meganet.' || t, 'select')));

  perform pg_temp.check_that('anon may read no record table',
    (select bool_and(not has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(v_private) t),
    (select string_agg(t, ', ') from unnest(v_private) t
      where has_table_privilege('anon', 'meganet.' || t, 'select')));

  perform pg_temp.check_that('anon may write nothing at all',
    (select bool_and(not has_table_privilege('anon', 'meganet.' || t, 'insert')
                 and not has_table_privilege('anon', 'meganet.' || t, 'update')
                 and not has_table_privilege('anon', 'meganet.' || t, 'delete'))
       from unnest(v_public || v_private) t));

  perform pg_temp.check_that('authenticated may write nothing directly either',
    (select bool_and(not has_table_privilege('authenticated', 'meganet.' || t, 'insert'))
       from unnest(v_private) t),
    'the only ways in are meganet.save_inspection() and meganet.save_maintenance_activity()');

  perform pg_temp.check_that('anon cannot call the save functions',
    not has_function_privilege('anon', 'meganet.save_inspection(jsonb, timestamptz)', 'execute')
    and not has_function_privilege('anon', 'meganet.save_maintenance_activity(jsonb, timestamptz)', 'execute'));

  perform pg_temp.check_that('anon cannot read a record through inspection_doc() either',
    not has_function_privilege('anon', 'meganet.inspection_doc(uuid)', 'execute'));

  perform pg_temp.check_that('nobody a browser can reach may call form_write()',
    not has_function_privilege('anon', 'meganet.form_write(text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'meganet.form_write(text, jsonb)', 'execute'),
    'it builds an INSERT with dynamic SQL; the save functions reach it as definer');

  perform pg_temp.check_that('form_write() refuses a table that is not on its list',
    pg_temp.raises('select meganet.form_write(''station'', ''{"id":"x"}''::jsonb)', '22023'));

  perform pg_temp.check_that('an editor may read the records',
    (select bool_and(has_table_privilege('authenticated', 'meganet.' || t, 'select'))
       from unnest(v_private) t));
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
