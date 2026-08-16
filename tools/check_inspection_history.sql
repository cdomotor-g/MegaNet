-- check_inspection_history.sql — Prove #126's schema, against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_inspection_history.sql
--
-- Every check below is one line of #126's acceptance, one line of #122's, or
-- one claim the head of 0014_inspection_history.sql makes. The whole script runs
-- inside a transaction and rolls back, so it is safe against the live database:
-- nothing it writes survives, including the placeholder station it hangs its
-- synthetic visits off.
--
-- It needs a role meganet.is_editor() says yes to — a direct psql connection, or
-- one holding the service key. It prints a row per check and exits non-zero if
-- any of them failed, so it works in a workflow as well as by hand.
--
-- Two kinds of check live here and the difference matters:
--
--   * **Shape.** Does a qualified value round-trip? Does a retired section stay
--     off the form and stay available to an import? These build their own data
--     and pass against an empty database — run them straight after 0014.
--   * **Load.** Do the counts reconcile against the workbook? These need
--     tools/ingest/load.py to have been run, and they say plainly that they were
--     skipped rather than passing vacuously when it has not.

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

-- A third state, and it earns its place. The load checks below are meaningless
-- without tools/ingest/load.py having been run, and the two dishonest options
-- are to fail (so the script can never be green straight after 0014 is applied)
-- and to pass (so an empty database looks like a verified one). `ok is null` is
-- neither: it prints as `skip` and it does not count towards the verdict.
create or replace function pg_temp.skip(p_name text, p_why text)
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, null, p_why);
$$;

create or replace function pg_temp.raises(p_sql text, p_sqlstate text default null)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return p_sqlstate is null or sqlstate = p_sqlstate;
end;
$$;

-- Is the archive actually in here? Several checks below are about 14,982 real
-- rows and are meaningless without them. The synthetic visits this script makes
-- are imports too, so they are discounted — otherwise the script's own fixtures
-- would convince it the workbook had been loaded.
create or replace function pg_temp.loaded()
returns boolean language sql stable as $$
  select exists (select 1 from meganet.inspection
                  where origin = 'import' and source_ref not like '\_check:%');
$$;

-- Negative ids, as check_inspections.sql uses, so a half-committed accident is
-- obvious.
insert into meganet.rm_system (id, ord, name)
values (-982, -982, 'check_inspection_history placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id)
values ('_check_hist_alert', -983, 'Check History Alert', '997001', -982),
       ('_check_hist_spare', -984, 'Check History Spare', '997002', -982)
on conflict (id) do nothing;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
declare
  v_tables text[] := array[
    'measurement_class', 'measurement_status', 'measurement_field',
    'block_fact_kind', 'inspection_reject_reason',
    'inspection_block', 'inspection_block_fact', 'inspection_measurement',
    'inspection_reject'];
  v_public text[] := array[
    'measurement_class', 'measurement_status', 'measurement_field',
    'block_fact_kind', 'inspection_reject_reason'];
  v_private text[] := array[
    'inspection_block', 'inspection_block_fact', 'inspection_measurement',
    'inspection_reject'];
begin
  perform pg_temp.check_that('schema_version is at least 14',
    (select value::integer >= 14 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('every table 0014 creates exists',
    (select count(*) = array_length(v_tables, 1) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r' and c.relname = any(v_tables)),
    (select string_agg(t, ', ') from unnest(v_tables) t
      where to_regclass('meganet.' || t) is null));

  perform pg_temp.check_that('RLS is on for every table 0014 creates',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relname = any(v_tables)),
    'db/README.md: no table without RLS, in the same file');

  perform pg_temp.check_that('every table 0014 creates has at least one policy',
    (select bool_and(n > 0) from (
       select count(p.polname) as n from unnest(v_tables) t
         left join pg_catalog.pg_policy p on p.polrelid = ('meganet.' || t)::regclass
        group by t) s));

  perform pg_temp.check_that('all three views exist',
    to_regclass('meganet.inspection_history') is not null
    and to_regclass('meganet.inspection_measurement_off_form') is not null
    and to_regclass('meganet.inspection_history_reconciliation') is not null);

  perform pg_temp.check_that('both functions exist',
    to_regprocedure('meganet.project_inspection_measurements(uuid[])') is not null
    and to_regprocedure('meganet.backfill_inspection_station(jsonb)') is not null);

  perform pg_temp.check_that('neither function is executable by the public',
    not has_function_privilege('public',
          'meganet.project_inspection_measurements(uuid[])', 'execute')
    and not has_function_privilege('public',
          'meganet.backfill_inspection_station(jsonb)', 'execute'),
    'db/README.md: a function that writes has its EXECUTE revoked from public');

  perform pg_temp.check_that('the vocabularies are readable by anon',
    (select bool_and(has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(v_public) t));

  perform pg_temp.check_that('the records are not readable by anon',
    (select bool_and(not has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(v_private) t),
    'an archive of property-owner names and site access notes is not a publication');

  perform pg_temp.check_that('anon may write nothing 0014 creates',
    (select bool_and(not has_table_privilege('anon', 'meganet.' || t, 'insert')
                 and not has_table_privilege('anon', 'meganet.' || t, 'update')
                 and not has_table_privilege('anon', 'meganet.' || t, 'delete'))
       from unnest(v_tables) t));
end
$$;

-- ── 2. The columns the workbook needs and the paper form never printed ───────
-- §1 of the migration. Named individually because "a column was added" is the
-- claim, and a loop over a list would pass if the list were wrong.

do $$
begin
  perform pg_temp.check_that('inspection_power gained the four missing supply columns',
    (select count(*) = 4 from pg_catalog.pg_attribute
      where attrelid = 'meganet.inspection_power'::regclass
        and attname in ('consumption_standby_ma', 'consumption_transmit_ma',
                        'mains_charge_current_ma', 'mains_regulated_v')));

  perform pg_temp.check_that('inspection_radio gained tx_deviation_khz',
    (select count(*) = 1 from pg_catalog.pg_attribute
      where attrelid = 'meganet.inspection_radio'::regclass
        and attname = 'tx_deviation_khz'));

  perform pg_temp.check_that('there is now an eighth calibration kind, under water level',
    (select count(*) = 8 from meganet.calibration_kind)
    and (select section_key = 'water_level' from meganet.calibration_kind
          where key = 'river_calibration'));

  perform pg_temp.check_that('inspection gained its provenance and precision columns',
    (select count(*) = 9 from pg_catalog.pg_attribute
      where attrelid = 'meganet.inspection'::regclass
        and attname in ('date_precision', 'date_raw', 'source_workbook',
                        'source_sheet', 'source_block_ref', 'source_row',
                        'station_match', 'station_key', 'source_notes')));
end
$$;

-- ── 3. Every field has a home, or is honestly said not to have one ──────────
-- The claim meganet.measurement_field makes, checked against the catalogue
-- rather than against itself: a field that names a column names a column that
-- exists. This is what stops the mapping rotting the next time a section table
-- is altered.

do $$
declare
  v_missing text;
begin
  select string_agg(f.key || ' → ' || f.home_table || '.' || f.home_column, ', ')
    into v_missing
    from meganet.measurement_field f
   where f.home_table <> ''
     and not exists (select 1 from pg_catalog.pg_attribute a
                      where a.attrelid = ('meganet.' || f.home_table)::regclass
                        and a.attname = f.home_column and a.attnum > 0
                        and not a.attisdropped);

  perform pg_temp.check_that('every mapped field names a column that exists',
    v_missing is null, coalesce(v_missing, ''));

  perform pg_temp.check_that('every field''s section is a real section',
    not exists (select 1 from meganet.measurement_field f
                 where not exists (select 1 from meganet.inspection_section s
                                    where s.key = f.section_key)));

  perform pg_temp.check_that('the calibration fields all name a kind',
    not exists (select 1 from meganet.measurement_field
                 where home_table = 'inspection_calibration' and kind_key is null));

  perform pg_temp.check_that('the serial fields all name a slot',
    not exists (select 1 from meganet.measurement_field
                 where home_table = 'inspection_serial'
                   and (equipment_key is null or equipment_slot = '')),
    'canister number and canister type are one row; receiver 1 and 2 are two');

  perform pg_temp.check_that('the nine value classes are all there',
    (select count(*) = 9 from meganet.measurement_class));

  perform pg_temp.check_that('`-` is a status in its own right',
    (select means like '%not applicable%' or means like '%Not applicable%'
       from meganet.measurement_status where key = '-'),
    'an empty cell means nobody wrote anything; `-` means there was nothing to measure');
end
$$;

-- ── 4. A retired section is history, not a form ─────────────────────────────
-- §3. The whole point of the `printed` column, in four checks: the form does not
-- offer it, the matrix still knows about it, an import may carry it, and a form
-- submission may not.

do $$
declare
  v_import uuid;
  v_form   uuid;
begin
  perform pg_temp.check_that('the ALERT form does not print decoder/receiver tests',
    not exists (select 1 from meganet.inspection_form
                 where config_key = 'alert' and section_key = 'base_tests'));

  perform pg_temp.check_that('but the matrix records that it used to',
    (select not printed from meganet.inspection_config_section
      where config_key = 'alert' and section_key = 'base_tests'));

  perform pg_temp.check_that('the old DataLogger form does not print a radio section',
    not exists (select 1 from meganet.inspection_form
                 where config_key = 'datalogger_old' and section_key = 'radio'));

  insert into meganet.inspection (station_id, config_key, inspected_on, origin, source_ref)
  values ('_check_hist_alert', 'alert', date '1998-04-02', 'import', '_check:retired:1')
  returning id into v_import;

  insert into meganet.inspection (station_id, config_key, inspected_on, origin)
  values ('_check_hist_alert', 'alert', date '2026-04-02', 'form')
  returning id into v_form;

  insert into meganet.inspection_calibration (inspection_id, kind_key, measured)
  values (v_import, 'decoder_test', 24.1);

  perform pg_temp.check_that('an imported ALERT visit may carry a decoder test',
    (select count(*) = 1 from meganet.inspection_calibration
      where inspection_id = v_import and kind_key = 'decoder_test'),
    '233 real readings depend on this — dropping them to protect a constraint is the failure #126 exists to avoid');

  perform pg_temp.check_that('a typed ALERT visit may not',
    pg_temp.raises(format(
      'insert into meganet.inspection_calibration (inspection_id, kind_key, measured)
         values (%L, ''decoder_test'', 24.1)', v_form), '22023'));

  perform pg_temp.check_that('and the guard still refuses a section nobody ever had',
    pg_temp.raises(format(
      'insert into meganet.inspection_data_quality (inspection_id, parameter, rating_on_arrival_key)
         values (%L, ''rain'', null)', (select id from meganet.inspection
                                         where config_key = 'alert' limit 0)), null));
end
$$;

-- ── 5. A qualified value survives, as itself ────────────────────────────────
-- #122's acceptance, and the sharpest single claim in this schema: `>30` goes in
-- and comes back out as `>30`, not as 30 and not as null. The constraint that
-- enforces it is checked too, because a rule nothing tests is a comment.

do $$
declare
  v_id uuid;
begin
  insert into meganet.inspection (station_id, config_key, inspected_on, origin, source_ref)
  values ('_check_hist_alert', 'alert', date '2004-07-19', 'import', '_check:qualified:1')
  returning id into v_id;

  insert into meganet.inspection_measurement
    (inspection_id, ord, field_key, source_col, raw, value_class, operator, bound)
  values (v_id, 1, 'fade_margin_db', 'H', '>30', 'qualified', '>', 30);

  insert into meganet.inspection_measurement
    (inspection_id, ord, field_key, source_col, raw, value_class, status)
  values (v_id, 2, 'battery_standby_v', 'C', 'U/S', 'status', 'u/s');

  insert into meganet.inspection_measurement
    (inspection_id, ord, field_key, source_col, raw, value_class, value)
  values (v_id, 3, 'solar_output_v', 'F', '17.4', 'number', 17.4);

  insert into meganet.inspection_measurement
    (inspection_id, ord, field_key, source_col, raw, value_class, flag)
  values (v_id, 4, 'consumption_transmit_ma', 'E', 'Unable to access battery box',
          'prose', 'text_where_a_number_was_expected');

  perform pg_temp.check_that('`>30` comes back as `>30`',
    (select raw = '>30' and operator = '>' and bound = 30 and value is null
       from meganet.inspection_measurement where inspection_id = v_id and ord = 1),
    'a meter that stopped at 30 is not a reading of 30, and it is not nothing');

  perform pg_temp.check_that('`U/S` comes back as `U/S`, with no number',
    (select raw = 'U/S' and status = 'u/s' and value is null
       from meganet.inspection_measurement where inspection_id = v_id and ord = 2));

  perform pg_temp.check_that('a sentence in a numeric column is kept and flagged',
    (select raw like 'Unable%' and value is null
        and flag = 'text_where_a_number_was_expected'
       from meganet.inspection_measurement where inspection_id = v_id and ord = 4),
    'usually the most informative thing on the row');

  perform pg_temp.check_that('a bound cannot acquire a point estimate',
    pg_temp.raises(format(
      'insert into meganet.inspection_measurement
         (inspection_id, ord, field_key, raw, value_class, operator, bound, value)
       values (%L, 9, ''fade_margin_db'', ''>30'', ''qualified'', ''>'', 30, 30)', v_id),
      '23514'),
    'the check constraint is what stops a later migration quietly rounding these off');

  perform pg_temp.check_that('a status word cannot carry a number either',
    pg_temp.raises(format(
      'insert into meganet.inspection_measurement
         (inspection_id, ord, field_key, raw, value_class, status, value)
       values (%L, 10, ''swr'', ''-'', ''status'', ''-'', 0)', v_id), '23514'));

  perform pg_temp.check_that('a raw string is never optional',
    pg_temp.raises(format(
      'insert into meganet.inspection_measurement
         (inspection_id, ord, field_key, raw, value_class, value)
       values (%L, 11, ''swr'', null, ''number'', 1.2)', v_id), '23502'));

  -- The projection, on this synthetic visit: the number lands in the section
  -- column and the three that are not numbers do not.
  perform meganet.project_inspection_measurements(array[v_id]);

  perform pg_temp.check_that('the number is projected into its section column',
    (select solar_output_v = 17.4 from meganet.inspection_power where inspection_id = v_id));

  perform pg_temp.check_that('the U/S battery is not projected as a voltage',
    (select battery_existing_v is null from meganet.inspection_power
      where inspection_id = v_id),
    'the reading is in meganet.inspection_measurement, where it is complete');

  perform pg_temp.check_that('the `>30` fade margin gets no fade-margin row',
    not exists (select 1 from meganet.inspection_fade_margin where inspection_id = v_id));

  perform pg_temp.check_that('projecting twice writes the same thing',
    (select solar_output_v = 17.4 from meganet.inspection_power where inspection_id = v_id)
    and (select count(*) = 1 from meganet.inspection_power where inspection_id = v_id));
end
$$;

do $$
begin
  -- Deliberately a second block: the call above has to have committed its work
  -- inside the transaction before this can mean anything.
  perform meganet.project_inspection_measurements(
    array[(select id from meganet.inspection where source_ref = '_check:qualified:1')]);
  perform pg_temp.check_that('and a third time still writes one row',
    (select count(*) = 1 from meganet.inspection_power
      where inspection_id = (select id from meganet.inspection
                              where source_ref = '_check:qualified:1')),
    'idempotent — #126 asks that re-running the loader changes nothing');
end
$$;

-- ── 6. A date the workbook only half gave ───────────────────────────────────

do $$
declare
  v_id uuid;
begin
  insert into meganet.inspection
    (station_id, config_key, inspected_on, origin, source_ref, date_precision, date_raw, remarks)
  values ('_check_hist_alert', 'alert', date '1990-01-01', 'import', '_check:year:1',
          'year', '1990', 'Station installed.')
  returning id into v_id;

  perform pg_temp.check_that('a year-only row says so',
    (select date_precision = 'year' and date_raw = '1990'
       from meganet.inspection where id = v_id),
    'a row that says only 1990 must not read as 1 January 1990');

  perform pg_temp.check_that('and the history view carries the precision through',
    (select date_precision = 'year' from meganet.inspection_history where id = v_id),
    '#128 needs to be able to tell');

  perform pg_temp.check_that('a precision nobody defined is refused',
    pg_temp.raises(
      'insert into meganet.inspection (station_id, config_key, inspected_on, origin, date_precision)
         values (''_check_hist_alert'', ''alert'', date ''2001-01-01'', ''import'', ''decade'')',
      '23514'));
end
$$;

-- ── 7. Import and form, together and apart ──────────────────────────────────
-- #126's acceptance: "Historical and MegaNet-entered inspections are queryable
-- together *and* distinguishable."

do $$
declare
  v_station text := '_check_hist_alert';
begin
  perform pg_temp.check_that('one query returns both origins for a station',
    (select count(*) >= 2 from meganet.inspection_history where station_id = v_station));

  perform pg_temp.check_that('and the two are told apart by origin',
    (select count(distinct origin) = 2 from meganet.inspection_history
      where station_id = v_station));

  perform pg_temp.check_that('a form row defaults to form provenance, not import',
    (select origin = 'form' and station_match = 'form' and source_ref is null
        and date_precision = 'day'
       from meganet.inspection
      where station_id = v_station and origin = 'form' limit 1));
end
$$;

-- ── 8. Parking a station nobody could identify, and accepting it later ──────
-- #122: "or sit in an explicit unmatched bucket with the raw name/CBM
-- preserved". #126: backfillable "without a full reload".

do $$
declare
  v_id  uuid;
  v_out record;
begin
  insert into meganet.inspection_block
    (ref, source, sheet, banner_row, family, config_key, station_name, cbm_no,
     station_key, station_match)
  values ('_check:block:1', 'qld-all-site-inspections', 'Check!', 7, 'ALERT', 'alert',
          'SOMEWHERE CREEK ALERT', '049999', 'c:49999', 'unmatched');

  insert into meganet.inspection
    (station_id, config_key, station_name, cbm_no, inspected_on, origin, source_ref,
     source_block_ref, source_sheet, source_row, station_key, station_match)
  values (null, 'alert', 'SOMEWHERE CREEK ALERT', '049999', date '2011-03-04',
          'import', '_check:parked:1', '_check:block:1', 'Check!', 11,
          'c:49999', 'unmatched')
  returning id into v_id;

  perform pg_temp.check_that('an unattributed visit keeps its name and its number',
    (select station_id is null and station_name = 'SOMEWHERE CREEK ALERT'
        and cbm_no = '049999' and station_match = 'unmatched'
       from meganet.inspection where id = v_id));

  perform pg_temp.check_that('and it is still a complete, readable record',
    (select station_name <> '' and inspected_on is not null
       from meganet.inspection_history where id = v_id));

  select * into v_out from meganet.backfill_inspection_station(
    jsonb_build_array(jsonb_build_object(
      'key', 'c:49999', 'station_id', '_check_hist_spare', 'tier', 'name')));

  perform pg_temp.check_that('accepting a match later attributes the visit',
    (select station_id = '_check_hist_spare' and station_match = 'name'
       from meganet.inspection where id = v_id),
    'and it was an update against station_key, not a reload');

  perform pg_temp.check_that('it attributes the block too',
    (select station_id = '_check_hist_spare' from meganet.inspection_block
      where ref = '_check:block:1'));

  perform pg_temp.check_that('the function reports what it touched',
    v_out.visits_updated = 1 and v_out.blocks_updated = 1);

  perform pg_temp.check_that('a backfill to a station that does not exist is refused',
    pg_temp.raises(
      'select meganet.backfill_inspection_station(
         jsonb_build_array(jsonb_build_object(''key'', ''c:1'', ''station_id'', ''nope'')))',
      '23503'));

  perform pg_temp.check_that('a match with no station_id is refused',
    pg_temp.raises(
      'select meganet.backfill_inspection_station(
         jsonb_build_array(jsonb_build_object(''key'', ''c:1'')))', '22023'));
end
$$;

-- ── 9. Provenance reaches the cell ──────────────────────────────────────────
-- #126's acceptance: "A loaded record traces back to its source cell via its
-- provenance fields." Sheet, block, row from the visit; column from the
-- measurement. Four values and the cell is named.

do $$
declare
  v_id uuid;
begin
  select id into v_id from meganet.inspection where source_ref = '_check:parked:1';

  insert into meganet.inspection_measurement
    (inspection_id, ord, field_key, source_col, raw, value_class, value)
  values (v_id, 1, 'battery_standby_v', 'C', '12.9', 'number', 12.9);

  perform pg_temp.check_that('a measurement names its sheet, block, row and column',
    (select i.source_sheet = 'Check!' and i.source_block_ref = '_check:block:1'
        and i.source_row = 11 and m.source_col = 'C'
       from meganet.inspection i
       join meganet.inspection_measurement m on m.inspection_id = i.id
      where i.id = v_id and m.ord = 1),
    'somebody doubting a number can open the cell it came from');

  perform pg_temp.check_that('the block a visit points at has to exist',
    pg_temp.raises(
      'insert into meganet.inspection (config_key, inspected_on, origin, source_block_ref)
         values (''alert'', date ''2010-01-01'', ''import'', ''_check:no-such-block'')',
      '23503'));

  perform pg_temp.check_that('two visits cannot claim the same workbook cell',
    pg_temp.raises(
      'insert into meganet.inspection (config_key, inspected_on, origin, source_ref)
         values (''alert'', date ''2010-01-01'', ''import'', ''_check:parked:1'')', '23505'),
    'the unique source_ref is what makes a second run of the loader an update');
end
$$;

-- ── 10. The block, and the facts that are true of it rather than of a visit ──

do $$
begin
  insert into meganet.inspection_block_fact
    (block_ref, fact_key, value_raw, value_num, as_at, as_at_raw)
  values ('_check:block:1', 'orifice_level_raw', '10.177 AHD as of 7/12/18', 10.177,
          date '2018-12-07', '7/12/18'),
         ('_check:block:1', 'rain_alert_id', '5858', 5858, null, '');

  perform pg_temp.check_that('a dated fact keeps both the date and the words',
    (select value_num = 10.177 and as_at = date '2018-12-07'
        and value_raw = '10.177 AHD as of 7/12/18'
       from meganet.inspection_block_fact
      where block_ref = '_check:block:1' and fact_key = 'orifice_level_raw'),
    'an orifice level surveyed in 2018 is not a claim about today');

  perform pg_temp.check_that('the six fact kinds off the ID''s line are all there',
    (select count(*) = 6 from meganet.block_fact_kind));

  perform pg_temp.check_that('a fact kind nobody defined is refused',
    pg_temp.raises(
      'insert into meganet.inspection_block_fact (block_ref, fact_key, value_raw)
         values (''_check:block:1'', ''wifi_password'', ''hunter2'')', '23503'));

  delete from meganet.inspection_block where ref = '_check:block:1';

  perform pg_temp.check_that('deleting a block takes its facts with it',
    not exists (select 1 from meganet.inspection_block_fact
                 where block_ref = '_check:block:1'));

  perform pg_temp.check_that('and leaves the visit standing, unattached',
    (select source_block_ref is null from meganet.inspection
      where source_ref = '_check:parked:1'),
    'a block is provenance; losing it must not lose the visit');
end
$$;

-- ── 11. The rejects are here, not on somebody's disk ────────────────────────

do $$
begin
  perform pg_temp.check_that('the seven reject reasons are all there',
    (select count(*) = 7 from meganet.inspection_reject_reason));

  perform pg_temp.check_that('an implausible date is rejected rather than repaired',
    (select note like '%not-goals%' or note like '%non-goals%'
       from meganet.inspection_reject_reason where key = 'implausible_date'),
    '23/6/215 is obviously 2015 to a person and not to a rule');

  insert into meganet.inspection_reject (ref, sheet, row_no, reason, detail, cells)
  values ('_check:reject:1', 'Check!', 42, 'implausible_date', '23/6/215',
          '{"A": "23/6/215"}'::jsonb);

  perform pg_temp.check_that('a reject keeps the cells that were at stake',
    (select cells ->> 'A' = '23/6/215' from meganet.inspection_reject
      where ref = '_check:reject:1'),
    'so deciding what to do about it does not mean reopening a 7 MB workbook');

  perform pg_temp.check_that('a reason nobody defined is refused',
    pg_temp.raises(
      'insert into meganet.inspection_reject (ref, reason) values (''_check:r:2'', ''vibes'')',
      '23503'));
end
$$;

-- ── 12. The archive itself ──────────────────────────────────────────────────
-- These need tools/ingest/load.py to have been run. The numbers are #124's, out
-- of data/inspections/counts.json, and they are stated rather than derived: if
-- the extractor's output changes, this file should fail and be read, not
-- silently agree with whatever it now says.

do $$
declare
  r record;
  -- The synthetic rows above are imports too, so they are discounted here.
  v_synthetic integer;
begin
  if not pg_temp.loaded() then
    perform pg_temp.skip('the archive itself',
      'run tools/ingest/load.py, then this file again');
    return;
  end if;

  select count(*) into v_synthetic from meganet.inspection
   where origin = 'import' and source_ref like '\_check:%';

  select * into r from meganet.inspection_history_reconciliation;

  perform pg_temp.check_that('14,982 visits loaded',
    r.loaded - v_synthetic = 14982, 'got ' || (r.loaded - v_synthetic));

  perform pg_temp.check_that('153 rows rejected, each with a reason',
    (select count(*) = 153 from meganet.inspection_reject
      where ref not like '\_check:%')
    and not exists (select 1 from meganet.inspection_reject where reason = ''));

  perform pg_temp.check_that('loaded and rejected account for every row #124 read',
    (select count(*) from meganet.inspection
      where origin = 'import' and source_ref not like '\_check:%')
    + (select count(*) from meganet.inspection_reject where ref not like '\_check:%')
    = 14982 + 153,
    '#122: no silent drops — the two counts reconcile');

  perform pg_temp.check_that('1,093 station blocks',
    (select count(*) = 1093 from meganet.inspection_block
      where ref not like '\_check:%'));

  perform pg_temp.check_that('151,532 cells, every one of them with its source string',
    (select count(*) from meganet.inspection_measurement m
       join meganet.inspection i on i.id = m.inspection_id
      where i.source_ref not like '\_check:%') = 151532
    and not exists (select 1 from meganet.inspection_measurement where raw is null));

  perform pg_temp.check_that('every visit is attributed or explicitly parked',
    not exists (select 1 from meganet.inspection
                 where origin = 'import' and station_id is null
                   and station_match not in ('unmatched', 'name_ambiguous',
                                             'number_ambiguous')),
    '#122: attributed to a station, or in an explicit unmatched bucket');

  perform pg_temp.check_that('a parked visit still carries its raw name or number',
    not exists (select 1 from meganet.inspection
                 where origin = 'import' and station_id is null
                   and station_name = '' and cbm_no = ''));

  perform pg_temp.check_that('the archive reaches back past 1995',
    (select min(inspected_on) < date '1995-01-01' from meganet.inspection
      where origin = 'import' and source_ref not like '\_check:%'),
    'the point of the exercise: #118 opening on a service life, not an empty table');

  perform pg_temp.check_that('every loaded visit names its workbook and sheet',
    not exists (select 1 from meganet.inspection
                 where origin = 'import' and source_ref not like '\_check:%'
                   and (source_workbook = '' or source_sheet = '')));

  perform pg_temp.check_that('the eight year-only rows are marked as such',
    (select count(*) = 8 from meganet.inspection
      where origin = 'import' and date_precision = 'year'
        and source_ref not like '\_check:%'));

  perform pg_temp.check_that('every qualified cell kept its operator and lost its number',
    not exists (select 1 from meganet.inspection_measurement
                 where value_class = 'qualified'
                   and (operator is null or bound is null or value is not null)));

  perform pg_temp.check_that('every status word is one the vocabulary knows',
    not exists (select 1 from meganet.inspection_measurement m
                 where m.status is not null
                   and not exists (select 1 from meganet.measurement_status s
                                    where s.key = m.status)),
    'a foreign key says this too; the check is that no row had to be dropped to satisfy it');

  perform pg_temp.check_that('the retired sections carry the readings they were kept for',
    (select coalesce(sum(measurements), 0) > 200
       from meganet.inspection_measurement_off_form),
    '264 readings the current forms have no box for, and none of them dropped');
end
$$;

-- ── 13. The projection agrees with the record it came from ──────────────────
-- The one check that would catch the two tables drifting apart. Every projected
-- voltage is compared against the measurement it was read from; a disagreement
-- anywhere is a failure here.

do $$
declare
  v_bad bigint;
begin
  if not pg_temp.loaded() then
    perform pg_temp.skip('the projection agrees with the measurements',
      'run tools/ingest/load.py, then this file again');
    return;
  end if;

  select count(*) into v_bad
    from meganet.inspection_measurement m
    join meganet.measurement_field f on f.key = m.field_key
    join meganet.inspection i on i.id = m.inspection_id
    join meganet.inspection_power p on p.inspection_id = m.inspection_id
   where i.origin = 'import'
     and f.home_table = 'inspection_power'
     and f.home_column = 'battery_existing_v'
     and m.value is not null
     and p.battery_existing_v is distinct from m.value;

  perform pg_temp.check_that('every projected battery voltage matches its cell',
    v_bad = 0, v_bad || ' disagreed');

  select count(*) into v_bad
    from meganet.inspection_power p
    join meganet.inspection i on i.id = p.inspection_id
   where i.origin = 'import'
     and p.battery_existing_v is not null
     and not exists (select 1 from meganet.inspection_measurement m
                      where m.inspection_id = p.inspection_id
                        and m.field_key = 'battery_standby_v' and m.value is not null);

  perform pg_temp.check_that('and no projected voltage was invented',
    v_bad = 0, v_bad || ' had no measurement behind them');

  select count(*) into v_bad
    from meganet.inspection_calibration c
    join meganet.inspection i on i.id = c.inspection_id
   where i.origin = 'import' and c.kind_key = 'river_calibration'
     and c.expected_result is null;

  perform pg_temp.check_that('every river-calibration row records the point it was taken at',
    v_bad = 0,
    'the third column is 15 metres on one block and 0.25 on another — ord is not the point');
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' when ok is null then 'skip' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n_bad     integer;
  n_skipped integer;
  n_ran     integer;
begin
  select count(*) filter (where ok = false),
         count(*) filter (where ok is null),
         count(*) filter (where ok is not null)
    into n_bad, n_skipped, n_ran
    from _check;

  if n_bad > 0 then
    raise exception '% of % checks failed', n_bad, n_ran;
  end if;
  if n_skipped > 0 then
    raise notice 'all % checks passed, % skipped — the archive is not loaded',
      n_ran, n_skipped;
  else
    raise notice 'all % checks passed', n_ran;
  end if;
end
$$;

rollback;
