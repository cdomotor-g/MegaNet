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

  perform pg_temp.check_that('only Alert and Base Station have a radio section',
    (select array_agg(config_key order by config_key) from meganet.inspection_config_section
      where section_key = 'radio') = array['alert', 'base_station'],
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

  perform pg_temp.check_that('Base Station is the only form with decoder/receiver tests',
    (select array_agg(config_key) from meganet.inspection_config_section
      where section_key = 'base_tests') = array['base_station']);

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
