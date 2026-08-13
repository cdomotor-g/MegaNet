// MegaNet — inspections.js
//
//   Inspections   the Inspections tab: the six paper station-inspection sheets
//                 in `Inspection_sheets_for_printing.xlsx`, rendered from the
//                 form matrix #115 put in the database, filled in, drafted
//                 locally and saved through meganet.save_inspection().
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, DB_URL and DB_SCHEMA (via
// datastore.js only), registerTabTeardown; across to app.js for switchTab and
// goToStation from inline handlers, so at click time; to auth.js for Auth; to
// datastore.js for dbSelect, dbRpc and dbCanWrite; to attachments.js for the
// photo panel in the admin section; and to maintenance.js for
// Maintenance.startFrom(), from the prompt at the foot of a visit that departed
// poor — the printed cross-reference, followed. Nothing reaches into this file:
// the tab is rendered from renderMain()'s one case and nothing else calls in.
//
// The IIFE body builds its field tables and calls nothing, so this file's
// position among the modules is free — checked, not reasoned about
// (`npm run toplevel`). It builds no Leaflet map, so it registers none; it does
// register a teardown, because the draft autosave is a timer and a timer left
// running behind another tab is exactly what #142's registry exists for.
//
// ── Where the form comes from ────────────────────────────────────────────────
//
// There is one form, not six. #115's `meganet.inspection_form` view says which
// of the fourteen sections each of the six configurations prints, in that
// configuration's own print order, with a `variant_note` carrying what that
// sheet does differently. This file renders that, section by section, and gets
// "the Gas Only sheet has no rain section" from the database rather than from a
// hand-written layout that would drift from it.
//
// What the database does *not* hold is the field-by-field content of a section
// — the labels, the order of the boxes, which of `inspection_power`'s 26
// columns the Mace sheet actually prints. That is FIELDS below, read off the
// workbook cell by cell (`archive/Inspection sheets for printing.xlsx`).
//
// So the rule this file follows, and the reason it is worth stating:
//
//   **the matrix decides which sections print and in what order; the sheets
//   decide which boxes are inside one, what they are called, and what they
//   default to.**
//
// Where the two seem to disagree the matrix wins on presence, because the
// matrix is checked by 71 assertions in `tools/check_inspections.sql` and a
// cell dump is not. Two places where that mattered are marked `// matrix:` in
// FIELDS below.
//
// ── Every printed box has a column, since 0011 ───────────────────────────────
//
// It did not when this file was written. Two sheets printed five boxes #115's
// schema had nowhere for — the Base Station sheet's Time (A18), and the Mace
// battery block's DP voltage and DP voltage-under-load for both the existing and
// the replacement battery (Y22/AC22 and Y24/AC24). They were left visible rather
// than dropped, in the dashed `UNCAPTURED` block under the section that printed
// them, and #146 was the follow-up. `db/migrations/0011_printed_boxes.sql` is
// that follow-up, so the five are ordinary fields below and `UNCAPTURED` is
// empty.
//
// It is empty rather than gone. What it does — say on the sheet that a printed
// box has nowhere to go — is the only honest thing to do with the next one, and
// a mechanism that exists is a much smaller decision than a mechanism that has
// to be reinvented.
//
// ── Saving ───────────────────────────────────────────────────────────────────
//
// The document this file holds is exactly the one meganet.inspection_doc()
// returns, so a save round-trips one shape. Generated columns
// (`adjustment_indicated`, `swr_rating`, `section_key`) come back in it and are
// sent straight back out; meganet.form_write() skips them by definition, so
// nothing has to remember to strip them here.
//
// The records are editors-only — the anon key is published, and inspection
// remarks carry site access notes (0009's foot). So the vocabularies and the
// matrix render signed out and the form fills in signed out; the recent-visits
// list and Save need a session, and say so rather than failing at the network.
//
// Drafts are localStorage and deliberately not the database: the primary use is
// a field crew on a tablet at a remote site with no signal. A draft is this
// browser's, is never uploaded on its own, and is cleared when the visit it
// holds saves. MemMeter already counts localStorage as a holder, so this needs
// no new entry in its three lists.
//
// Issue #116 (I2), sub-issue of #78. Schema: db/migrations/0009_inspections.sql.

const Inspections = (function () {

  // ── The vocabularies and the matrix ────────────────────────────────────────
  // Everything fetched once, on first open, and kept for the session. All of it
  // is granted to `anon` in 0009 — a printed form's own words say nothing about
  // a site — so this works signed out and signing in adds nothing to it.

  const LOOKUPS = [
    'rain_instrument_type', 'condition_rating', 'wl_instrument_type',
    'power_supply', 'yes_no', 'data_quality_rating', 'equipment_kind',
  ];

  // The fourteen sections, the six configurations, the matrix, and the
  // calibration kinds. Separate from LOOKUPS only because they are read
  // differently below, not because they are fetched differently.
  const TABLES = ['inspection_config', 'inspection_section', 'calibration_kind'];

  // ── The sheets, box by box ─────────────────────────────────────────────────
  //
  // One entry per section key in meganet.inspection_section. Each is a list of
  // blocks; each block is a printed sub-heading and its fields. A field is:
  //
  //   t      'text' | 'num' | 'time' | 'date' | 'bool' | 'select' | 'area'
  //   k      the column in this section's table
  //   label  what the sheet prints beside the box
  //   only   configurations that print this box (absent: every configuration
  //          whose matrix row includes the section)
  //   lab    per-configuration label overrides, { mace: 'MACE Voltage (v)' }
  //   opts   lookup table name, for t === 'select'
  //   note   the sheet's own printed note beside the box
  //   full   the box spans the row (free text, mostly)
  //
  // `bool` is a three-state pick-list, not a checkbox, and that is a fidelity
  // decision rather than a styling one: the paper prints YES and NO with
  // neither circled far more often than it prints either, and a checkbox cannot
  // say "nobody answered this". Null is what the schema stores for that, and
  // the two option labels come off the Dropdown sheet like every other list.

  const F = (t, k, label, extra) => Object.assign({ t, k, label }, extra || {});

  const FIELDS = {

    // ── 1. Station Details ───────────────────────────────────────────────────
    // Headed "Base Station Details" on the base-station sheet. The two office
    // ticks are printed on Campbell, Mace and DataLogger - old and not on
    // Alert; the matrix's section note calls them core, so they render for
    // every configuration whose variant note does not remove them.
    // matrix: Alert's cell dump has no office row; the matrix does. Two
    // optional boxes on one form is the cheaper way to be wrong.
    station_details: [
      { fields: [
        F('text', 'station_name', 'Station Name', { lab: { base_station: 'Base Station Name' } }),
        F('text', 'cbm_no', 'CBM No'),
        F('num',  'alert_id', 'Alert ID', { only: ['gas_only'] }),
        F('num',  'lat', 'Co-ordinates — latitude', { not: ['gas_only', 'base_station'] }),
        F('num',  'lon', 'Co-ordinates — longitude', { not: ['gas_only', 'base_station'] }),
        F('date', 'inspected_on', 'Date', { lab: {
          campbell_datalogger: 'Date of Inspection', mace: 'Date of Inspection',
          datalogger_old: 'Date of Inspection' } }),
        // Base Station is the only sheet that prints a clock reading in its
        // details block (A18), and the only one with no data section for an
        // `at_time` to live in — so the column is on meganet.inspection. #146.
        F('time', 'inspected_at_time', 'Time', { only: ['base_station'] }),
        F('text', 'inspector', 'Initials', { not: ['gas_only', 'base_station'] }),
      ] },
      { title: 'Office — tick here after SitesDb & HDB/MIS entry',
        not: ['gas_only', 'base_station'],
        fields: [
          F('bool', 'office_last_visit', 'Last Visit'),
          F('bool', 'office_stock_changes', 'Stock changes'),
        ] },
      // Printed in the header band above every banner on three of the sheets,
      // which is why 0009 puts them on meganet.inspection rather than in the
      // rain section.
      { title: 'Tipping bucket rain gauge', only: ['campbell_datalogger', 'mace', 'datalogger_old'],
        fields: [
          F('text', 'rain_gauge_type', 'Rain gauge type'),
          F('text', 'rain_gauge_serial', 'Serial No', { only: ['mace', 'datalogger_old'] }),
        ] },
    ],

    // ── 3 / 11. Initial Data and Final Data ──────────────────────────────────
    // One shape, read twice. `phase` decides which banner it prints under and
    // the guard in 0009 reads the section off it.
    initial_data: [
      { fields: [
        F('time', 'at_time', 'Time'),
        F('time', 'logger_time', 'Logger Time', { only: ['campbell_datalogger', 'datalogger_old'] }),
        F('num',  'rain_logger', 'Rain', { lab: { mace: 'Mace Rain' } }),
        F('num',  'river_staff_gauge_m', 'Staff Gauge', { lab: {
          campbell_datalogger: 'River — staff gauge height',
          datalogger_old: 'River — staff gauge height' } }),
        F('num',  'river_logger', 'River', { lab: {
          mace: 'Mace River',
          campbell_datalogger: 'River — logger values',
          datalogger_old: 'River — logger value' } }),
        F('num',  'battery_v', 'Battery', { not: ['mace'] }),
        F('num',  'gas_pressure_kpa', 'Gas Pressure', { only: ['datalogger_old'] }),
        F('num',  'dp_counter', 'Counter (DP)', { only: ['mace'] }),
        F('bool', 'sends', 'Sends?', { only: ['campbell_datalogger'] }),
        F('num',  'rssi_dbm', 'RSSI', { only: ['campbell_datalogger'],
          note: 'Modmax: −105 dB weak · −105 to −95 dB OK · above −95 dB good' }),
        F('area', 'comments', 'Comments', { full: true }),
      ] },
    ],

    final_data: [
      { fields: [
        F('time', 'at_time', 'Time'),
        F('time', 'logger_time', 'Logger Time', { only: ['campbell_datalogger', 'datalogger_old'] }),
        F('num',  'rain_logger', 'Rain', { lab: { mace: 'Mace Rain' } }),
        F('num',  'river_staff_gauge_m', 'Staff Gauge', { lab: {
          campbell_datalogger: 'River — staff gauge height',
          datalogger_old: 'River — staff gauge height' } }),
        F('num',  'river_logger', 'River', { lab: {
          mace: 'Mace River',
          campbell_datalogger: 'River — logger values',
          datalogger_old: 'River — logger value' } }),
        F('num',  'battery_v', 'Battery', { not: ['mace'] }),
        F('num',  'gas_pressure_kpa', 'Gas Pressure', { only: ['datalogger_old'] }),
        F('num',  'dp_counter', 'Counter (DP)', { only: ['mace'] }),
        F('bool', 'sends', 'Sends?', { only: ['campbell_datalogger'] }),
        F('num',  'rssi_dbm', 'RSSI', { only: ['campbell_datalogger'] }),
        F('bool', 'staff_gauge_survey_done', 'Staff Gauge survey carried out?', { only: ['alert'] }),
        F('bool', 'data_coming_in', 'Check data coming in?', { only: ['campbell_datalogger'] }),
        F('bool', 'logger_cleared', 'Logger Cleared?', { only: ['campbell_datalogger', 'datalogger_old'],
          lab: { datalogger_old: 'Logger Dump and cleared?' } }),
        F('bool', 'modem_test_via_office', 'Final modem test via office?',
          { only: ['mace', 'datalogger_old'] }),
        F('area', 'comments', 'Comments', { full: true }),
      ] },
    ],

    // ── 4 / 5. Battery, and the supply that charges it ───────────────────────
    // Two banners, one table: 0009 keeps them together because they are one
    // power story and always print together.
    battery: [
      { title: 'Existing Battery', not: ['mace'], fields: [
        F('num',  'battery_existing_rating_ah', 'Rating (Ah)'),
        F('num',  'battery_existing_v', 'Voltage (V)'),
        F('num',  'battery_existing_v_under_load', 'Under Load (V)'),
        F('text', 'battery_existing_date_stamp', 'Date Stamp'),
      ] },
      { title: 'Replacement Battery', not: ['mace'], fields: [
        F('num',  'battery_replacement_rating_ah', 'Rating (Ah)'),
        F('num',  'battery_replacement_v', 'Voltage (V)'),
        F('num',  'battery_replacement_v_under_load', 'Under Load (V)'),
        F('text', 'battery_replacement_date_stamp', 'Date Stamp'),
      ] },
      // The Mace sheet prints the same two rows against MACE rather than a
      // battery, with the DP and phone voltages beside them.
      // The Mace sheet prints the same two rows against MACE rather than a
      // battery, with the DP and phone voltages beside them. The DP pair is
      // #146's — four columns 0009 had no room for, added in 0011, and the two
      // sub-columns are headed "DP" (Y21) and "DP (U/L)" (AC21) with
      // "Voltage (v)" printed under each on both rows.
      { title: 'Existing Battery', only: ['mace'], fields: [
        F('num', 'battery_existing_v', 'MACE Voltage (v)'),
        F('num', 'battery_existing_v_under_load', 'MACE (U/L) Voltage (v)'),
        F('num', 'dp_existing_v', 'DP Voltage (v)'),
        F('num', 'dp_existing_v_under_load', 'DP (U/L) Voltage (v)'),
      ] },
      { title: 'Replacement Battery', only: ['mace'], fields: [
        F('num', 'battery_replacement_v', 'MACE Voltage (v)'),
        F('num', 'battery_replacement_v_under_load', 'MACE (U/L) Voltage (v)'),
        F('num', 'dp_replacement_v', 'DP Voltage (v)'),
        F('num', 'dp_replacement_v_under_load', 'DP (U/L) Voltage (v)'),
      ] },
      { title: 'Consumption', only: ['campbell_datalogger', 'mace', 'datalogger_old'], fields: [
        F('num', 'consumption_sleep_ma', 'Sleep (mA)', { lab: { mace: 'MACE Sleep Consum.' } }),
        F('num', 'consumption_operating_ma', 'Operating (mA)', { lab: { mace: 'MACE Oper. Consum.' } }),
        F('num', 'consumption_interrogation_ma', 'Interrogation (mA)',
          { lab: { mace: 'MACE Interr. Consum.' } }),
        F('num', 'lithium_battery_v', 'Lithium Battery (V)',
          { only: ['campbell_datalogger', 'datalogger_old'], note: 'min. 2.90 V' }),
        F('num', 'telephone_socket_v', 'Voltage at socket (v)', { lab: {
          campbell_datalogger: 'Voltage at socket / RSSI (V)',
          datalogger_old: 'Voltage at Telephone socket (v)',
          mace: 'PHONE Voltage at socket (v)' } }),
      ] },
      { fields: [ F('area', 'comments', 'Comments', { full: true }) ] },
    ],

    power_supply: [
      { title: 'Solar Panel', fields: [
        F('select', 'power_key', 'Power', { opts: 'power_supply' }),
        F('num', 'solar_panel_rating_w', 'Power (w.)',
          { note: 'Mace prints 2 W / 10 W', lab: { mace: 'Power (w.) — 2 W / 10 W' } }),
        F('num', 'solar_output_v', 'Output Voltage (V)', { not: ['alert'] }),
        F('num', 'solar_voltage_at_plug_v', 'Output voltage at plug (v)', { only: ['alert'] }),
        F('num', 'solar_short_circuit_ma', 'Short Circuit Current (mA)'),
        F('num', 'solar_charge_current_ma', 'Charge Current (mA)'),
        F('num', 'solar_under_load_ma', 'Under Load (mA)',
          { only: ['campbell_datalogger', 'mace', 'datalogger_old'] }),
        F('num', 'solar_static_current_ma', 'Consumption Static (ma)', { only: ['alert'],
          note: 'individual / combined' }),
        F('num', 'solar_trickle_charge_ma', 'Trickle Charge (ma)', { only: ['alert'] }),
        F('num', 'solar_regulator_v', 'Solar Regulator (V)', { not: ['mace'],
          lab: { alert: 'Regulated Voltage (V)' } }),
        F('num', 'solar_step_up_v', 'Step up Voltage (v)', { only: ['datalogger_old'] }),
        F('text', 'led_on_arrival', 'Solar LED — on arrival', { only: ['alert', 'datalogger_old'],
          lab: { datalogger_old: 'Charge LED — arrive' } }),
        F('text', 'led_at_departure', 'Solar LED — at depart', { only: ['alert', 'datalogger_old'],
          lab: { datalogger_old: 'Charge LED — dep' } }),
        F('text', 'weather_note', 'Weather', { full: true,
          note: 'an output voltage read under cloud is not comparable to one read in sun' }),
      ] },
      { title: 'Mains Supply', not: ['mace'], fields: [
        F('bool', 'mains_clean_undamaged', 'Clean and undamaged?'),
      ] },
    ],

    // ── 6. Rain ──────────────────────────────────────────────────────────────
    rain_gauge: [
      { title: 'Gauge', fields: [
        F('select', 'instrument_type_key', 'Instrument type', { opts: 'rain_instrument_type' }),
        F('bool', 'gauge_level', 'Is gauge level?'),
        F('bool', 'drains_clear', 'Drains clear?'),
        F('bool', 'syphon_cleaned', 'Syphon Cleaned', { lab: { mace: 'Syphon clear?' } }),
        F('bool', 'switch_ok', 'Switch OK', { lab: { mace: 'Switch replaced?' } }),
        F('bool', 'strainer_ok', 'Strainer OK', { lab: { mace: 'Strainer replaced?' } }),
        F('bool', 'buckets_adjusted', 'Buckets Adjusted', { lab: { mace: 'Bucket adjusted?' } }),
        F('bool', 'calibration_check', 'Calibration check', { not: ['alert'] }),
        F('bool', 'tip_test_ok', 'TBRG Test OK', { only: ['alert'] }),
        // Printed in the header band on the Mace and DataLogger - old sheets
        // rather than inside the Rain banner, but they are rain-gauge facts and
        // 0009 puts them here.
        F('bool', 'syphon_fitted', 'Syphon fitted', { only: ['mace', 'datalogger_old'] }),
        F('bool', 'levelling_checked', 'Levelling checked',
          { only: ['alert', 'mace', 'datalogger_old'] }),
        F('bool', 'funnel_and_syphon_clean', 'Funnel and syphon clean and undamaged',
          { only: ['alert', 'mace', 'datalogger_old'] }),
      ] },
      { title: 'Accuracy check method', fields: [
        F('text', 'accuracy_check_method', 'Method', { full: true }),
        F('num', 'chamber_ml', 'Chamber (ml)', { only: ['campbell_datalogger', 'datalogger_old'],
          note: '653 ml → 200 mm/hr · 730 ml → 100 mm/hr' }),
        F('num', 'nozzle_mm_per_hr', 'Nozzle (mm/hr)',
          { only: ['campbell_datalogger', 'datalogger_old'] }),
      ] },
      { title: 'Expected measurement', note: 'the reference the tip test is read against',
        fields: [
          F('num', 'expected_rimco_mm', 'Rimco (mm)'),
          F('num', 'expected_rimco_tips', 'Rimco (tips)',
            { only: ['campbell_datalogger', 'datalogger_old'] }),
          F('num', 'expected_hs_mm', 'HS (mm)'),
          F('num', 'expected_hs_tips', 'HS (tips)',
            { only: ['campbell_datalogger', 'datalogger_old'] }),
        ] },
      // "TBRG Calibration Details" is the Alert sheet's heading for the grid
      // below, not for this box — so this stays "Comments" and the grid keeps
      // the sheet's words.
      { fields: [ F('area', 'comments', 'Comments', { full: true }) ] },
    ],

    // ── 7. River / Water Level ───────────────────────────────────────────────
    water_level: [
      { title: 'Instrument', not: ['gas_only'], fields: [
        F('select', 'instrument_type_key', 'WL instrument type', { opts: 'wl_instrument_type' }),
        F('text', 'transmitter_type', 'Transmitter Type', { not: ['mace'] }),
        F('text', 'transmitter_range', 'Transmitter Range', { lab: { mace: 'Range' } }),
        F('bool', 'calibration_check', 'Calibration check', { not: ['mace'] }),
        F('bool', 'shaft_encoder_checked', 'Shaft Encoder Checked', { only: ['datalogger_old'] }),
        F('num',  'shaft_encoder_increments_per_rev', 'Increments per revolution',
          { only: ['campbell_datalogger'], note: 'one full revolution = 36.5 increments' }),
        F('bool', 'current_wl_entered_for_ip_logger', 'Current WL entered for IP Logger?',
          { only: ['campbell_datalogger'] }),
        F('bool', 'druck_dpi_calibration_check', 'Calibration check with Druck DPI?',
          { only: ['mace'], note: 'overleaf' }),
      ] },
      { title: 'Staff gauge', not: ['gas_only'], fields: [
        F('bool', 'staff_gauge_in_good_condition', 'Staff gauges in good condition'),
        F('select', 'staff_gauge_condition_key', 'Condition', { opts: 'condition_rating' }),
        F('text', 'staff_gauge_range', 'Staff gauge range', { only: ['campbell_datalogger'] }),
        F('bool', 'staff_gauge_survey_done', 'Staff gauge survey carried out?',
          { only: ['campbell_datalogger'] }),
      ] },
      // The Gas Only sheet's entire water-level content: one printed line.
      { title: 'Staff Gauge', only: ['gas_only'], fields: [
        F('text', 'staff_gauge_note', 'Staff Gauge:', { full: true }),
      ] },
      { title: 'River (Analogue)', only: ['mace'], fields: [
        F('bool', 'capillary_line_purged', 'Capillary line purged?'),
        F('text', 'dp_delay', 'DP delay tested? (UP / DOWN)'),
        F('bool', 'dp_contacts_tested', 'DP contacts cleaned?'),
        F('bool', 'dp_counter_cleaned', 'DP counter cleaned?'),
        F('bool', 'dp_counter_adjusted', 'DP counter adjusted?'),
      ] },
      { not: ['gas_only'], fields: [ F('area', 'comments', 'Comments', { full: true }) ] },
    ],

    // ── 8. Gas ───────────────────────────────────────────────────────────────
    gas: [
      { title: 'Existing Cylinder', fields: [
        F('num', 'existing_cylinder_pressure_kpa', 'Cylinder Pressure (kPa)'),
        F('num', 'existing_feed_pressure_kpa', 'Feed Pressure (kPa)'),
        F('num', 'existing_bubble_rate_bpm', 'Bubble Rate (BPM)'),
      ] },
      { title: 'Replacement Cylinder', fields: [
        F('num', 'replacement_cylinder_pressure_kpa', 'Cylinder Pressure (kPa)'),
        F('num', 'replacement_feed_pressure_kpa', 'Feed Pressure (kPa)'),
        F('num', 'replacement_bubble_rate_bpm', 'Bubble Rate (BPM)'),
      ] },
      { title: 'Compressor', only: ['alert', 'campbell_datalogger', 'datalogger_old'], fields: [
        F('num',  'compressor_pump_cycle_from_kpa', 'Pump Cycle from (kPa)',
          { lab: { datalogger_old: 'HS40 Compressor on (kPa)' } }),
        F('num',  'compressor_pump_cycle_to_kpa', 'Pump Cycle to (kPa)',
          { lab: { datalogger_old: 'HS40 Compressor off (kPa)' } }),
        F('bool', 'compressor_status_normal', 'Status Normal Operation'),
        F('text', 'compressor_fault_code', 'Fault Code'),
      ] },
      { title: 'Filter / desiccant', only: ['alert', 'campbell_datalogger'], fields: [
        F('bool', 'filter_desiccant_checked', 'HS40 Filter / Amazon Desiccant Checked'),
        F('bool', 'filter_desiccant_replaced', 'Replaced'),
      ] },
      { title: 'Leaks and purge', fields: [
        F('bool', 'tested_for_leaks', 'Tested for leaks'),
        F('bool', 'leak_test_on_river_line_fitting',
          'Leak test on fitting to river line while purging',
          { only: ['alert', 'campbell_datalogger'] }),
        F('bool', 'orifice_checked', 'Orifice Checked', { only: ['alert', 'campbell_datalogger', 'datalogger_old'] }),
        F('num',  'bubble_unit_pressure_tested_m_h2o', 'Bubble Unit: Pressure Tested to (m.H2O)'),
        F('bool', 'system_purged', 'System Purged', { not: ['datalogger_old'] }),
        F('bool', 'gas_line_purged', 'Gas Line Purged', { only: ['datalogger_old'] }),
        F('bool', 'spare_cylinder_at_station', 'Spare cylinder at station?', { only: ['mace'] }),
        F('num',  'consumption_kpa_per_month', 'Gas consumption (kPa / month)'),
      ] },
      { fields: [ F('area', 'comments', 'Comments', { full: true }) ] },
    ],

    // ── 9. Antenna Tests ─────────────────────────────────────────────────────
    radio: [
      { fields: [ F('num', 'tx_size_w', 'TX Size (watts)') ] },
      { title: 'Existing Antenna', fields: [
        F('text', 'existing_antenna', 'Antenna'),
        F('num',  'existing_frequency_mhz', 'Frequency (MHz)'),
        F('num',  'existing_forward_w', 'Forward Power (w)'),
        F('num',  'existing_reflected_w', 'Reflected Power (w)'),
        F('num',  'existing_swr', 'SWR', { only: ['alert'],
          note: '<1.5 = Good · 1.5–2.0 = Fair · >2.0 = Poor' }),
      ] },
      { title: 'Replacement Antenna', fields: [
        F('text', 'replacement_antenna', 'Antenna'),
        F('num',  'replacement_frequency_mhz', 'Frequency (MHz)'),
        F('num',  'replacement_forward_w', 'Forward Power (w)'),
        F('num',  'replacement_reflected_w', 'Reflected Power (w)'),
        F('num',  'replacement_swr', 'SWR', { only: ['alert'] }),
      ] },
      { fields: [ F('area', 'comments', 'Comments', { full: true }) ] },
    ],

    // ── 12. Data Quality ─────────────────────────────────────────────────────
    // Rendered as its own two-row block rather than from FIELDS — see
    // dataQualityHtml(). The departure rating is what the printed instruction
    // at the foot of every sheet is read against.
    data_quality: [],

    // ── 13. Remarks ──────────────────────────────────────────────────────────
    remarks: [
      { fields: [
        F('area', 'remarks', 'Remarks', { full: true, lab: { campbell_datalogger: 'Comments' } }),
        F('area', 'next_visit_comments', 'Enter comments for next visit', { full: true, only: ['mace'] }),
      ] },
    ],

    // ── 14. Photos & Admin ───────────────────────────────────────────────────
    // The Base Station sheet prints five of the nine columns; the other four
    // stay null there, and the matrix is what says so.
    admin_checklist: [
      { fields: [
        F('bool', 'photos_taken', 'Photos'),
        F('bool', 'on_web', 'On Web?', { not: ['base_station'] }),
        F('bool', 'excel', 'Excel'),
        F('bool', 'wo_completed', 'WO Comp'),
        F('bool', 'meters_updated', 'Meters'),
        F('bool', 'eams_other', 'EAMS other'),
        F('bool', 'emon_op', "E'mon OP", { not: ['base_station'] }),
        F('bool', 'drs', 'DRS', { not: ['base_station'] }),
        F('bool', 'council_notified', 'Council', { not: ['base_station'] }),
        F('area', 'comments', 'Comments', { full: true }),
      ] },
    ],
  };

  // Which table each section's answers land in, keyed the way inspection_doc()
  // keys them. `inspection_section.home` names the table; this is the same fact
  // in the document's own vocabulary, and the one place the two are tied
  // together.
  const SECTION_DOC_KEY = {
    station_details: 'top',
    remarks:         'top',
    initial_data:    'data.initial',
    final_data:      'data.final',
    battery:         'power',
    power_supply:    'power',
    rain_gauge:      'rain_gauge',
    water_level:     'water_level',
    gas:             'gas',
    radio:           'radio',
    admin_checklist: 'admin',
  };

  // ── Serial Numbers, per sheet ──────────────────────────────────────────────
  // Read off the six Serial Numbers panels. `key` is meganet.equipment_kind;
  // `label` is that sheet's own wording, which is what
  // meganet.inspection_serial.label is for. Rows can be added and removed — the
  // panel is free text on paper and the sheets do not agree on its length.

  const SERIALS = {
    alert: [
      ['canister', 'Canister and version'], ['ert_a2', 'ERT A2 (F/W Build #)'],
      ['tbrg', 'TBRG'], ['water_level_sensor', 'Water Level Sensor'],
      ['bubble_unit', 'Bubble Unit'], ['key_number', 'Key #'],
      ['power_supply', 'Power Supply'],
    ],
    campbell_datalogger: [
      ['logger', 'Logger (OS & Program)'], ['modem', 'Modem'],
      ['antenna', 'Antenna & SIM'], ['tbrg', 'TBRG'], ['solar_panel', 'Solar Panel'],
      ['solar_regulator', 'Solar Regulator'], ['river_sensor', 'River Sensor'],
      ['bubble_unit', 'Bubble Unit'], ['gas_druck', 'Gas Druck'],
    ],
    mace: [
      ['mace', 'MACE'], ['tbrg', 'TBRG'], ['shaft_encoder', 'Shaft Encoder'],
      ['pressure_transmitter', 'Pressure Transmitter (or DP)'],
      ['solar_panel', 'Solar Panel'], ['pha', 'PHA'], ['bubble_unit', 'Bubble Unit'],
    ],
    gas_only: [
      ['canister', 'Canister and version'], ['tbrg', 'TBRG'],
      ['shaft_encoder', 'Shaft Encoder'], ['pressure_transmitter', 'Pressure Transmitter'],
      ['solar_panel', 'Solar Panel'], ['bubble_unit', 'Bubble Unit'],
      ['power_supply', 'Power Supply'],
    ],
    base_station: [
      ['receiver', 'Receiver and version'], ['receiver', 'Receiver and version'],
      ['decoder', 'Decoder and version'],
    ],
    datalogger_old: [
      ['logger', 'Logger'], ['modem', 'Modem'], ['bubble_unit', 'Bubble Unit'],
      ['tbrg', 'TBRG'], ['solar_panel', 'Solar Panel'],
      ['shaft_encoder', 'Shaft Encoder'], ['pressure_transmitter', 'Pressure Transmitter'],
      ['other', 'Other'],
    ],
  };

  // ── The calibration blocks, per sheet ──────────────────────────────────────
  //
  // Decision 4 of 0009: sixty-one printed layouts collapse into one table keyed
  // by kind. What varies per sheet is which kinds print, how many rows, whether
  // there is an initial and a final grid, and which of the seven columns the
  // grid actually shows. That is this table.
  //
  // Every block is filtered at render time against meganet.calibration_kind and
  // the matrix before it is offered, so the form can never present a block the
  // database's own guard would refuse. See plannedCalibrations().
  //
  //   cols   which columns this sheet's grid prints, in its order
  //   labels this sheet's own column headings, where they differ
  //   rows   how many, and phases ['none'] or ['initial','final']

  const CAL_COLS = {
    expected_result: 'Expected Result', start_value: 'Start Value', end_value: 'End Value',
    result: 'Result', measured: 'Measured', difference: 'Difference', pct_error: '% Error',
    revolutions: 'Revolutions', error_m: 'Error (m.)', frequency_mhz: 'Frequency',
    supply_v: 'Power supplied from decoder', passed: 'Adj. made?',
  };

  const CALIBRATIONS = {
    alert: [
      { kind: 'rain_tip_test', title: 'TBRG Calibration Details', phases: ['none'], rows: 3,
        cols: ['start_value', 'end_value', 'result'],
        labels: { start_value: 'Start Accum', end_value: 'End Accum' } },
      { kind: 'rain_recalibration', title: 'Rain Recalibration', phases: ['none'], rows: 1,
        cols: ['start_value', 'end_value', 'result'],
        labels: { start_value: 'Start Accum.', end_value: 'End Accum.' } },
      { kind: 'druck', title: 'Druck Calibration', phases: ['none'], rows: 1,
        cols: ['start_value', 'measured', 'end_value', 'error_m'],
        labels: { start_value: 'DPI Pump', measured: 'Test Set', end_value: 'Logger / Display' } },
      { kind: 'shaft_encoder', title: 'Shaft Encoder Check', phases: ['none'], rows: 1,
        cols: ['revolutions', 'start_value', 'end_value', 'result'],
        labels: { revolutions: 'Revs.' } },
      { kind: 'enviromon', title: 'Enviromon Calibration', phases: ['none'], rows: 1,
        cols: ['result'], labels: { result: 'Div.' },
        extra: [['b_offset', 'B. Offset'], ['zero_adj', 'Zero Adj.']],
        note: 'printed inside the Final Reset Data block; B. Offset and Zero Adj. '
            + 'go to inspection_calibration.extra, which is what it is for' },
    ],
    campbell_datalogger: [
      { kind: 'rain_tip_test', title: 'Calibration', phases: ['initial', 'final'], rows: 3,
        units: 'mm/tips',
        cols: ['expected_result', 'start_value', 'end_value', 'result', 'difference', 'pct_error'],
        finalCols: ['passed', 'expected_result', 'start_value', 'end_value', 'result',
                    'difference', 'pct_error'] },
      { kind: 'druck', title: 'Druck Calibration', phases: ['none'], rows: 1,
        cols: ['start_value', 'end_value', 'error_m'],
        labels: { start_value: 'DPI Pump', end_value: 'Logger' } },
      { kind: 'shaft_encoder', title: 'Shaft Encoder Calibration', phases: ['none'], rows: 1,
        cols: ['revolutions', 'start_value', 'end_value', 'result'],
        note: 'nb. check DNRM level on WL3100 first · one full revolution = 36.5 increments' },
    ],
    mace: [
      { kind: 'rain_tip_test', title: 'Calibration', phases: ['initial', 'final'], rows: 3,
        units: 'mm',
        cols: ['expected_result', 'start_value', 'measured', 'difference', 'pct_error'],
        labels: { start_value: 'Accumulator values' },
        note: 'post-adjustment or replacement comparison' },
      { kind: 'rain_recalibration', title: 'Rain accumulator check', phases: ['none'], rows: 1,
        cols: ['start_value', 'end_value', 'result'],
        labels: { start_value: 'Start Accum', end_value: 'End Accum', result: 'Result (20mm)' } },
      { kind: 'druck', title: 'Druck Calibration', phases: ['none'], rows: 1,
        cols: ['start_value', 'end_value', 'error_m'],
        labels: { start_value: 'DPI Pump', end_value: 'MACE / Logger' } },
      { kind: 'shaft_encoder', title: 'Shaft Encoder Calibration', phases: ['none'], rows: 1,
        cols: ['revolutions', 'start_value', 'end_value', 'result'] },
    ],
    datalogger_old: [
      { kind: 'rain_tip_test', title: 'Calibration', phases: ['initial', 'final'], rows: 3,
        units: 'mm',
        cols: ['expected_result', 'start_value', 'end_value', 'result', 'difference', 'pct_error'],
        note: 'post adjustment or replacement comparison' },
      { kind: 'druck', title: 'Druck Calibration', phases: ['none'], rows: 1,
        cols: ['start_value', 'end_value', 'error_m'],
        labels: { start_value: 'DPI Pump', end_value: 'Logger' } },
      { kind: 'shaft_encoder', title: 'Shaft Encoder Calibration', phases: ['none'], rows: 1,
        cols: ['revolutions', 'start_value', 'end_value', 'result'] },
    ],
    base_station: [
      { kind: 'decoder_test', title: 'Decoder Test', phases: ['none'], rows: 1,
        cols: ['expected_result', 'measured'],
        labels: { measured: 'Measured output value' },
        defaults: { expected_result: 24 },
        note: 'expected output voltage is 24.0 v. +/- 3.0 v.' },
      { kind: 'receiver_test', title: 'Receiver Test', phases: ['none'], rows: 2,
        cols: ['frequency_mhz', 'supply_v', 'measured'],
        labels: { measured: 'Measured value' } },
    ],
    gas_only: [],
  };

  // ── What the sheet already has printed on it ───────────────────────────────
  //
  // The reference values a tip test is read against are not something a crew
  // works out — they are printed on the form, and they differ per sheet: Alert
  // says HS 10.0 mm and Rimco 10.4 mm, Campbell and the old logger say Rimco
  // 20.2 mm / 101 tips and HS 20.8 mm / 104 tips, Mace says 9.7 mm on a Rimco
  // and 10.3 mm into an HS gauge. 0009 stores them per visit rather than as
  // constants for the same reason it stores the 6% threshold that way, so the
  // form fills them in and lets them be changed rather than hard-coding them
  // into the arithmetic.
  const DEFAULTS = {
    alert: {
      rain_gauge: { expected_hs_mm: 10.0, expected_rimco_mm: 10.4 },
    },
    campbell_datalogger: {
      rain_gauge: { expected_rimco_mm: 20.2, expected_rimco_tips: 101,
                    expected_hs_mm: 20.8, expected_hs_tips: 104,
                    accuracy_check_method: 'HS Field Calibration Tool' },
      water_level: { shaft_encoder_increments_per_rev: 36.5 },
    },
    mace: {
      rain_gauge: { expected_rimco_mm: 9.707, expected_hs_mm: 10.302,
                    accuracy_check_method: 'When using water from a standard rain measure, '
                                         + 'a RIMCO calibration tool must be used' },
    },
    datalogger_old: {
      rain_gauge: { expected_rimco_mm: 20.2, expected_rimco_tips: 101,
                    expected_hs_mm: 20.8, expected_hs_tips: 104,
                    accuracy_check_method: 'HS Field Calibration Tool — 653 ml chamber / '
                                         + '200 mm/hr nozzle' },
    },
  };

  function defaultsFor(cfg, key) {
    return (DEFAULTS[cfg] && DEFAULTS[cfg][key]) || {};
  }

  // The three tip-test rows are what the printed 6% rule is read against, so the
  // kinds whose mean matters are named rather than inferred.
  const MEAN_KIND = 'rain_tip_test';

  // The Alert sheet's PATH MARGIN (dB) table, in two passes. Only that sheet
  // prints it — the Base Station's radio section is antenna tests and nothing
  // else, which the matrix says in its variant note.
  const FADE_MARGIN_CONFIGS = ['alert'];

  // Printed on a sheet, and with nowhere in the schema to record it. Rendered
  // under the section that prints it rather than dropped in silence — the same
  // principle as "does not apply is data", applied to the schema's own gaps.
  // Keyed configuration → section, so the note appears where the box would be.
  //
  // Empty since 0011, and kept rather than deleted: every one of the six sheets
  // now maps box for box, and the mechanism is what says so. Deleting it would
  // make the next unhomed box a choice between inventing this again and dropping
  // the box quietly, and the second is the cheaper mistake to make. The two
  // entries that were here — the Base Station Time and the four Mace DP voltages
  // — are columns now (#146).
  const UNCAPTURED = {};

  // ── Local state ────────────────────────────────────────────────────────────

  const S = () => state.insp;

  const DRAFTS_KEY = 'mn-insp-drafts';

  let saveTimer = null;
  let registered = false;

  // ── Reference data ─────────────────────────────────────────────────────────

  // Fetched once per session. Never rejects: every caller wants to render the
  // failure, not catch it, and a tab that throws on a blocked network is a tab
  // that fails the smoke test for the wrong reason.
  function loadRefs() {
    const s = S();
    if (s.refs || s.refsLoading) return;
    s.refsLoading = true;
    s.refsError = null;
    repaint();

    const want = [
      ['form',     'inspection_form?select=*&order=config_key,ord'],
      ...TABLES.map(t => [t, `${t}?select=*&order=ord`]),
      ...LOOKUPS.map(t => [t, `${t}?select=*&order=ord`]),
    ];

    Promise.all(want.map(([name, path]) =>
      dbSelect(path).then(rows => [name, rows])))
      .then(pairs => {
        const refs = {};
        pairs.forEach(([name, rows]) => { refs[name] = rows; });
        s.refs = refs;
        s.refsLoading = false;
        repaint();
      })
      .catch(err => {
        s.refsLoading = false;
        // Deliberately not console.error: a blocked or sleeping datastore is a
        // state this tab renders, not a fault to shout about.
        s.refsError = (err && err.message) || String(err);
        repaint();
      });
  }

  function lookup(name) { return (S().refs && S().refs[name]) || []; }

  function configs() { return lookup('inspection_config'); }

  function configLabel(key) {
    const c = configs().find(c => c.key === key);
    return c ? c.label : key;
  }

  // The sections this configuration's form prints, in its own print order.
  // Straight off meganet.inspection_form — this is the answer to "does this
  // form have a gas section", and it is the database's answer rather than this
  // file's.
  function sectionsFor(cfg) {
    return lookup('form').filter(r => r.config_key === cfg)
      .slice().sort((a, b) => a.ord - b.ord);
  }

  function sectionPrinted(cfg, key) {
    return sectionsFor(cfg).some(r => r.section_key === key);
  }

  // The fourteen sections this configuration does *not* print. A gap the form
  // states is a different thing from a gap it leaves blank — see 0009's
  // decision 2, which is the whole reason the matrix exists.
  function sectionsNotOnForm(cfg) {
    const has = new Set(sectionsFor(cfg).map(r => r.section_key));
    return lookup('inspection_section').filter(s => !has.has(s.key));
  }

  // Every calibration block this sheet prints that the database would also
  // accept. The second half is not belt-and-braces: `inspection_calibration`'s
  // guard reads the section off the kind and refuses a row whose section the
  // configuration does not print, so a block offered here that the guard would
  // reject is a save that fails after the typing.
  function plannedCalibrations(cfg) {
    const kinds = lookup('calibration_kind');
    return (CALIBRATIONS[cfg] || []).filter(block => {
      const kind = kinds.find(k => k.key === block.kind);
      return kind && sectionPrinted(cfg, kind.section_key);
    });
  }

  function calSection(kindKey) {
    const k = lookup('calibration_kind').find(k => k.key === kindKey);
    return k ? k.section_key : '';
  }

  // ── The document ───────────────────────────────────────────────────────────
  // Exactly the shape meganet.inspection_doc() returns, so a save round-trips
  // one shape and a reload needs no translation.

  function blankDoc(cfg, station) {
    return {
      id: null,
      station_id: station ? station.id : null,
      config_key: cfg,
      station_name: station ? station.name : '',
      cbm_no: station ? (station.station_number || '') : '',
      alert_id: null,
      lat: station && station.lat != null ? station.lat : null,
      lon: station && station.lon != null ? station.lon : null,
      inspected_on: todayIso(),
      // Deliberately not defaulted to the clock: the Base Station sheet's Time
      // is what somebody wrote down, and now() would read as that rather than
      // as a guess. Same call 0009 made about inspection_data.at_time. #146.
      inspected_at_time: null,
      inspector: '',
      office_last_visit: null,
      office_stock_changes: null,
      rain_gauge_type: '',
      rain_gauge_serial: '',
      remarks: '',
      next_visit_comments: '',
      origin: 'form',
      serials: [],
      data: {},
      power: null, rain_gauge: null, water_level: null, gas: null, radio: null, admin: null,
      fade_margin: [], calibrations: [], data_quality: [], attachments: [],
    };
  }

  function todayIso() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Materialise every row the rendered form addresses by index, so that setting
  // a value never has to create one and an index never shifts under a keystroke.
  // Called on open, on a configuration change, and after a load — the three
  // moments the section set can change.
  function ensureRows(doc) {
    const cfg = doc.config_key;

    // Sections this configuration prints get an object; the others are left
    // null, because a section table with no row means "not recorded" and a
    // section absent from the matrix means "not on this form". Writing an empty
    // object for a section the form does not print would be refused by the
    // guard, and rightly.
    ['power', 'rain_gauge', 'water_level', 'gas', 'radio', 'admin'].forEach(key => {
      const printed = Object.keys(SECTION_DOC_KEY)
        .some(sec => SECTION_DOC_KEY[sec] === key && sectionPrinted(cfg, sec));
      if (printed && !doc[key]) doc[key] = Object.assign({}, defaultsFor(cfg, key));
      if (!printed) doc[key] = null;
    });

    if (!doc.data) doc.data = {};
    ['initial', 'final'].forEach(phase => {
      const printed = sectionPrinted(cfg, `${phase}_data`);
      if (printed && !doc.data[phase]) doc.data[phase] = { values: [] };
      if (printed && !Array.isArray(doc.data[phase].values)) doc.data[phase].values = [];
      if (!printed) delete doc.data[phase];
    });

    if (!Array.isArray(doc.serials)) doc.serials = [];
    if (!doc.serials.length && sectionPrinted(cfg, 'serial_numbers')) {
      doc.serials = (SERIALS[cfg] || []).map(([equipment_key, label], i) => ({
        ord: i + 1, equipment_key, label, model: '', serial_no: '', version: '', comments: '',
      }));
    }
    if (!sectionPrinted(cfg, 'serial_numbers')) doc.serials = [];

    // Calibrations are created from the plan rather than added by hand: every
    // sheet prints a fixed grid, and a row nobody filled in saves as nulls,
    // which is what a blank box on paper is.
    const want = [];
    plannedCalibrations(cfg).forEach(block => {
      block.phases.forEach(phase => {
        for (let ord = 1; ord <= block.rows; ord++) {
          const had = (doc.calibrations || []).find(r =>
            r.kind_key === block.kind && (r.phase || 'none') === phase && r.ord === ord);
          want.push(had || Object.assign({
            kind_key: block.kind, phase, ord, label: '', method: '',
            units: block.units || '', extra: {},
          }, block.defaults || {}));
        }
      });
    });
    doc.calibrations = want;

    if (!Array.isArray(doc.fade_margin)) doc.fade_margin = [];
    if (!fadeMarginOn(cfg)) doc.fade_margin = [];

    if (!Array.isArray(doc.data_quality)) doc.data_quality = [];
    if (sectionPrinted(cfg, 'data_quality')) {
      // Rain first, then water level — the order the sheet prints them in.
      doc.data_quality = ['rain', 'water_level'].map(parameter =>
        doc.data_quality.find(r => r.parameter === parameter)
        || { parameter, on_arrival_key: null, on_departure_key: null, comments: '' });
    } else {
      doc.data_quality = [];
    }
    return doc;
  }

  function fadeMarginOn(cfg) {
    return FADE_MARGIN_CONFIGS.includes(cfg) && sectionPrinted(cfg, 'radio');
  }

  // ── Reading and writing one box ────────────────────────────────────────────
  // Every input names its own path into the document, so a keystroke updates
  // one value and repaints nothing. The alternative — read the whole form out
  // of the DOM at save time — needs an id per box and loses everything the
  // moment a section re-renders, which on a tablet in the field is the failure
  // that matters.

  function container(path) {
    const doc = S().doc;
    if (!doc) return null;
    const bits = path.split('.');
    let node = doc;
    for (let i = 0; i < bits.length - 1; i++) {
      const key = bits[i];
      if (key === 'top') continue;
      node = node[/^\d+$/.test(key) ? Number(key) : key];
      if (node == null) return null;
    }
    return node;
  }

  function get(path) {
    const node = container(path);
    if (!node) return null;
    const last = path.split('.').pop();
    return node[last];
  }

  function set(path, raw, type) {
    const node = container(path);
    if (!node) return;
    const last = path.split('.').pop();
    let v = raw;
    if (type === 'num') v = raw === '' || raw == null ? null : Number(raw);
    else if (type === 'bool') v = raw === '' ? null : raw === 'true';
    else if (type === 'sel') v = raw === '' ? null : raw;
    else if (type === 'time') v = raw === '' ? null : raw;
    if (type === 'num' && v != null && !Number.isFinite(v)) v = null;
    node[last] = v;
    // Typing into the Mean box is the one edit that must not be immediately
    // overwritten by the value computed from the three checks. The sheet prints
    // that box for a person to fill in; computing it is the improvement, and
    // taking the pen out of their hand mid-word is not.
    afterEdit(last === 'mean_pct_error');
  }

  // Everything a keystroke has to keep true, and nothing else. The document is
  // not re-rendered: the derived readouts are patched in place, so the caret
  // stays where it was.
  function afterEdit(skipMean) {
    S().dirty = true;
    if (!skipMean) recomputeMean();
    paintDerived();
    scheduleDraft();
  }

  // ── The printed 6% rule, computed ──────────────────────────────────────────
  // "Calibration adjustment should only be performed if the mean % error after
  // 3 checks is greater than 6%." Printed on four of the six sheets, in words,
  // beside a box nobody computes. 0009 stores the threshold per visit rather
  // than as a constant so that changing it never rewrites what a past visit was
  // judged against; this reads it back out rather than assuming 6.

  function tipRows(phase) {
    const doc = S().doc;
    if (!doc) return [];
    return (doc.calibrations || []).filter(r =>
      r.kind_key === MEAN_KIND && (phase ? (r.phase || 'none') === phase : true));
  }

  function meanPctError() {
    // The mean the sheet asks for is across the three checks. Where a sheet
    // prints an initial and a final grid it is the final one that the rule is
    // read against — the initial grid is what was found, the final is what was
    // left behind.
    const finals = tipRows('final');
    const rows = finals.length ? finals : tipRows(null);
    const vals = rows.map(r => r.pct_error).filter(v => v != null && Number.isFinite(Number(v)));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + Number(b), 0) / vals.length;
  }

  function recomputeMean() {
    const doc = S().doc;
    if (!doc || !doc.rain_gauge) return;
    const mean = meanPctError();
    if (mean == null) return;                    // nothing typed yet; leave what is there
    doc.rain_gauge.mean_pct_error = Math.round(mean * 1000) / 1000;
  }

  function adjustmentThreshold() {
    const rg = S().doc && S().doc.rain_gauge;
    const t = rg && rg.adjustment_threshold_pct;
    return t == null ? 6 : Number(t);
  }

  // ── The printed cross-reference, as a live prompt ──────────────────────────
  // "* sites on departure that are poor or have issues please complete Flood
  // Warning Council Maintenance Project form" is printed at the foot of every
  // inspection sheet. meganet.data_quality_rating.needs_maintenance is which
  // ratings it means, so this reads the database's answer rather than matching
  // on the word "poor".

  function needsMaintenance() {
    const doc = S().doc;
    if (!doc) return [];
    const ratings = lookup('data_quality_rating');
    return (doc.data_quality || []).filter(r => {
      const rating = ratings.find(x => x.key === r.on_departure_key);
      return rating && rating.needs_maintenance;
    }).map(r => {
      const rating = ratings.find(x => x.key === r.on_departure_key);
      return { parameter: r.parameter, label: rating.label };
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function render() {
    const s = S();
    return `
      <div class="insp-page">
        ${headerHtml()}
        ${s.refsError ? refsErrorHtml()
          : !s.refs ? `<div class="panel insp-note">Loading the form…</div>`
          : s.doc ? formHtml()
          : pickerHtml()}
      </div>`;
  }

  function headerHtml() {
    const s = S();
    return `
      <div class="panel insp-head">
        <div class="panel-header">
          <h2>Station Inspections</h2>
          <div class="insp-head-actions">
            ${s.doc ? `<button onclick="Inspections.close()">← All inspections</button>` : ''}
          </div>
        </div>
        <p class="small insp-sub">
          The six paper station-inspection sheets, digitised. Which sections a form prints comes
          from <code>meganet.inspection_form</code> — the station's configuration decides the form,
          the same way the workbook's own <em>Index</em> sheet says it does.
        </p>
        <div id="insp-status" class="small">${statusHtml()}</div>
      </div>`;
  }

  function refsErrorHtml() {
    return `
      <div class="panel insp-note insp-bad">
        <strong>The form itself could not be loaded.</strong>
        <p class="small">The sections each configuration prints, and every pick-list on the form,
          are read from the datastore — they are the printed form's own words and are readable
          without signing in. This browser could not reach them: ${esc(S().refsError)}</p>
        <p class="small">Nothing on this tab can be filled in until it can.
          Any draft already saved on this device is untouched.</p>
        <button class="primary" onclick="Inspections.retry()">Try again</button>
      </div>`;
  }

  function statusHtml() {
    const s = S();
    if (s.msg) {
      const colour = s.msg.kind === 'error' ? 'var(--bad)'
                   : s.msg.kind === 'ok' ? 'var(--ok)' : 'var(--muted)';
      return `<span style="color:${colour}">${esc(s.msg.text)}</span>`;
    }
    if (!dbCanWrite()) {
      return `<span style="color:var(--muted)">Not signed in — the form fills in, but the
        database refuses anonymous writes and will not show past visits either.
        <a href="#" onclick="Auth.open();return false">Sign in</a> to save;
        everything typed is kept while you do, and drafts save to this device regardless.</span>`;
    }
    if (!Auth.mayWrite()) {
      return `<span style="color:var(--warn)">Signed in as ${esc(Auth.email() || 'you')}, but this
        address is not on the editors list, so a save will be refused. An administrator has to add
        it (see <code>docs/access.md</code>). Drafts still save to this device.</span>`;
    }
    return '';
  }

  // ── The picker ─────────────────────────────────────────────────────────────

  function pickerHtml() {
    const s = S();
    return `
      <div class="insp-cols">
        <div class="panel">
          <div class="panel-header"><h3>Start an inspection</h3></div>
          <label class="insp-search">Station
            <input type="search" id="insp-q" value="${escAttr(s.query)}"
                   placeholder="name, station number or ALERT address"
                   oninput="Inspections.search(this.value)">
          </label>
          <div id="insp-matches">${matchesHtml()}</div>
          <p class="small insp-muted">
            An inspection can also be recorded for a site that is not in the list —
            <button class="btn-link" onclick="Inspections.pick(null)">start one without a station</button>.
            The form keeps the name and CBM No either way, which is what makes a visit to a site
            nobody has added yet a complete record.
          </p>
        </div>
        <div class="stack">
          ${draftsHtml()}
          ${recentHtml()}
        </div>
      </div>`;
  }

  function matchesHtml() {
    const s = S();
    const q = s.query.trim().toLowerCase();
    if (!q) return `<p class="small insp-muted">Type to search ${
      state.data ? (state.data.stations || []).length.toLocaleString() : 'the'} stations.</p>`;
    const all = (state.data && state.data.stations) || [];
    const hits = all.filter(st =>
      (st.name || '').toLowerCase().includes(q) ||
      (st.station_number || '').toLowerCase().includes(q) ||
      Object.values(st.alert_ids || {}).some(id => String(id) === q)
    ).slice(0, 25);
    if (!hits.length) return `<p class="small insp-muted">No station matches “${esc(s.query)}”.</p>`;
    return `
      <div class="insp-hits">
        ${hits.map(st => `
          <button class="insp-hit" onclick="Inspections.pick('${escAttr(st.id)}')">
            <span class="insp-hit-name">${esc(st.name)}</span>
            <span class="small insp-muted">${esc(st.station_number || '—')}${
              st.roles && st.roles.length ? ` · ${esc(st.roles.join(', '))}` : ''}</span>
          </button>`).join('')}
      </div>`;
  }

  // Which form to open on. The workbook's Index sheet is explicit that form
  // identity follows the station's telemetry type — and `stations.json` has no
  // telemetry-type field. `roles` is the only signal it carries, and it only
  // separates infrastructure from a field site. So the strongest available
  // answer is what somebody chose the last time this station was inspected,
  // and where there is no answer this says so rather than guessing. #147 is the
  // follow-up: put the configuration on the station record itself.
  function suggestConfig(station) {
    if (!station) return { key: '', why: '' };
    const prev = (S().recent || []).find(r => r.station_id === station.id);
    if (prev) {
      return { key: prev.config_key,
               why: `the most recent inspection at this station, on ${prev.inspected_on}` };
    }
    if ((station.roles || []).includes('base')) {
      return { key: 'base_station', why: 'this station is recorded as base-station infrastructure' };
    }
    return { key: '', why: '' };
  }

  function draftsHtml() {
    const drafts = readDrafts();
    const keys = Object.keys(drafts);
    if (!keys.length) return '';
    return `
      <div class="panel">
        <div class="panel-header"><h3>Drafts on this device</h3></div>
        <p class="small insp-muted">Saved in this browser, not in the database. A draft never
          leaves this device on its own — open it and press Save when there is a signal.</p>
        <div class="insp-list">
          ${keys.map(id => {
            const d = drafts[id];
            return `
              <div class="insp-row">
                <button class="btn-link" onclick="Inspections.resume('${escAttr(id)}')">
                  ${esc(d.title || 'Untitled visit')}
                </button>
                <span class="small insp-muted">${esc(configLabel(d.config_key))} ·
                  ${esc(d.inspected_on || '')} · saved ${esc(new Date(d.savedAt).toLocaleString())}</span>
                <button class="insp-drop" title="Discard this draft"
                        onclick="Inspections.discard('${escAttr(id)}')">Discard</button>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function recentHtml() {
    const s = S();
    if (!dbCanWrite()) {
      return `
        <div class="panel">
          <div class="panel-header"><h3>Recent inspections</h3></div>
          <p class="small insp-muted">Past visits are editors-only — an inspection's remarks carry
            site access notes, and the anon key this app ships with is published.
            <a href="#" onclick="Auth.open();return false">Sign in</a> to see them.</p>
        </div>`;
    }
    if (s.recentError) {
      return `
        <div class="panel">
          <div class="panel-header"><h3>Recent inspections</h3>
            <button onclick="Inspections.refresh()">Retry</button></div>
          <p class="small" style="color:var(--bad)">${esc(s.recentError)}</p>
        </div>`;
    }
    if (!s.recent) {
      return `<div class="panel"><div class="panel-header"><h3>Recent inspections</h3></div>
        <p class="small insp-muted">Loading…</p></div>`;
    }
    if (!s.recent.length) {
      return `<div class="panel"><div class="panel-header"><h3>Recent inspections</h3></div>
        <p class="small insp-muted">No inspections recorded yet.</p></div>`;
    }
    return `
      <div class="panel">
        <div class="panel-header"><h3>Recent inspections</h3>
          <button onclick="Inspections.refresh()">Refresh</button></div>
        <div class="insp-list">
          ${s.recent.map(r => `
            <div class="insp-row">
              <button class="btn-link" onclick="Inspections.open('${escAttr(r.id)}')">
                ${esc(r.station_name || r.station_id || 'Unnamed site')}
              </button>
              <span class="small insp-muted">${esc(configLabel(r.config_key))} ·
                ${esc(r.inspected_on)}${r.inspector ? ` · ${esc(r.inspector)}` : ''}${
                r.origin === 'import' ? ' · imported' : ''}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  // ── The form ───────────────────────────────────────────────────────────────

  function formHtml() {
    const doc = S().doc;
    const cfg = doc.config_key;
    const rows = sectionsFor(cfg);
    // The photo panel in the admin section is built as a string inside this one
    // render, so attachments.js has to know which record is on screen before it
    // runs. Idempotent — it loads the type vocabulary once for the session and
    // this record's index rows once, then repaints its own nodes.
    Attachments.forRecord('inspection', doc.id);
    return `
      ${formHeadHtml()}
      ${rows.map(row => sectionHtml(row)).join('')}
      ${notOnFormHtml(cfg)}
      ${formFootHtml()}`;
  }

  function formHeadHtml() {
    const doc = S().doc;
    const s = S();
    const cfgs = configs();
    const sug = s.suggestion;
    return `
      <div class="panel insp-form-head">
        <div class="panel-header">
          <h3>${esc(doc.station_name || 'New inspection')}${
            doc.id ? '' : ' <span class="small insp-muted">— not saved yet</span>'}</h3>
          <div class="insp-head-actions">
            <button onclick="Inspections.saveDraft()">Save draft</button>
            ${dbCanWrite()
              ? `<button class="primary" id="insp-save" onclick="Inspections.save()"
                        ${s.busy ? 'disabled' : ''}>Save to the database</button>`
              : `<button class="primary" onclick="Auth.open()"
                        title="Saving needs a signed-in session">Sign in to save</button>`}
          </div>
        </div>
        <label class="insp-cfg">Station configuration — which form this is
          <select onchange="Inspections.setConfig(this.value)">
            ${cfgs.map(c => `<option value="${escAttr(c.key)}"
              ${c.key === doc.config_key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </label>
        <p class="small insp-muted">
          ${sug && sug.why
            ? `Pre-selected from ${esc(sug.why)}.`
            : `Nothing on the station record says which telemetry a site runs, so this could not be
               pre-selected — pick the sheet the crew would print.`}
          ${configNote(doc.config_key)}
        </p>
      </div>`;
  }

  function configNote(cfg) {
    const c = configs().find(c => c.key === cfg);
    if (!c) return '';
    return `<span class="insp-sheet">Sheet <code>${esc(c.sheet)}</code> — ${esc(c.note)}</span>`;
  }

  function sectionHtml(row) {
    const cfg = row.config_key;
    const key = row.section_key;
    const banner = `
      <div class="insp-banner">
        <span class="insp-banner-ord">${row.ord}</span>
        <span class="insp-banner-label">${esc(sectionLabel(row))}</span>
      </div>
      ${row.variant_note ? `<p class="small insp-variant">${esc(row.variant_note)}</p>` : ''}`;

    let body = '';
    if (key === 'serial_numbers')      body = serialsHtml(cfg);
    else if (key === 'data_quality')   body = dataQualityHtml();
    else if (key === 'base_tests')     body = calibrationsHtml(cfg, key);
    else {
      body = blocksHtml(cfg, key)
           + (key === 'radio' && fadeMarginOn(cfg) ? fadeMarginHtml() : '')
           + calibrationsHtml(cfg, key)
           + (key === 'initial_data' || key === 'final_data' ? dataValuesHtml(key) : '')
           + (key === 'rain_gauge' ? tipRuleHtml() : '')
           + (key === 'admin_checklist' ? photosHtml() + crossRefHtml() : '');
    }

    const gaps = (UNCAPTURED[cfg] && UNCAPTURED[cfg][key]) || [];
    return `
      <section class="panel insp-section" data-section="${escAttr(key)}">
        ${banner}
        ${body}
        ${gaps.length ? uncapturedHtml(gaps) : ''}
      </section>`;
  }

  function sectionLabel(row) {
    // The two sections whose banner the sheet renames. The matrix's variant
    // note is where that is recorded; these are the two where the heading
    // itself — not a field inside it — is what changed.
    const RENAME = {
      'base_station|station_details': 'Base Station Details',
      'alert|final_data':             'Final Reset Data',
      'mace|final_data':              'Data at end of visit',
      'campbell_datalogger|remarks':  'Comments',
      'campbell_datalogger|serial_numbers': 'Model and Serial Numbers',
    };
    return RENAME[`${row.config_key}|${row.section_key}`] || row.section_label;
  }

  function uncapturedHtml(gaps) {
    return `
      <div class="insp-gap">
        <strong>Printed on this sheet, with nowhere to record it yet</strong>
        <ul class="small">${gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
        <p class="small insp-muted">Left visible rather than dropped quietly. Extending the schema
          for these is issue #146.</p>
      </div>`;
  }

  function blocksHtml(cfg, sectionKey) {
    const blocks = FIELDS[sectionKey] || [];
    const base = SECTION_DOC_KEY[sectionKey];
    if (!base) return '';
    return blocks.filter(b => applies(b, cfg)).map(block => {
      const fields = block.fields.filter(f => applies(f, cfg));
      if (!fields.length) return '';
      return `
        ${block.title ? `<h4 class="insp-block">${esc(block.title)}</h4>` : ''}
        ${block.note ? `<p class="small insp-muted">${esc(block.note)}</p>` : ''}
        <div class="insp-grid">
          ${fields.map(f => fieldHtml(`${base}.${f.k}`, f, cfg)).join('')}
        </div>`;
    }).join('');
  }

  function applies(spec, cfg) {
    if (spec.only && !spec.only.includes(cfg)) return false;
    if (spec.not && spec.not.includes(cfg)) return false;
    return true;
  }

  function labelOf(f, cfg) {
    return (f.lab && f.lab[cfg]) || f.label;
  }

  function fieldHtml(path, f, cfg) {
    const label = labelOf(f, cfg);
    const v = get(path);
    const note = f.note ? `<span class="insp-hint">${esc(f.note)}</span>` : '';
    const cls = f.full || f.t === 'area' ? 'insp-field full' : 'insp-field';
    let input;
    if (f.t === 'area') {
      input = `<textarea rows="3" oninput="Inspections.set('${escAttr(path)}',this.value,'text')"
                >${esc(v || '')}</textarea>`;
    } else if (f.t === 'bool') {
      input = boolHtml(path, v);
    } else if (f.t === 'select') {
      input = selectHtml(path, v, f.opts);
    } else if (f.t === 'num') {
      input = `<input type="number" step="any" value="${escAttr(v == null ? '' : v)}"
                      oninput="Inspections.set('${escAttr(path)}',this.value,'num')">`;
    } else if (f.t === 'time') {
      input = `<input type="time" value="${escAttr(hhmm(v))}"
                      oninput="Inspections.set('${escAttr(path)}',this.value,'time')">`;
    } else if (f.t === 'date') {
      input = `<input type="date" value="${escAttr(v || '')}"
                      oninput="Inspections.set('${escAttr(path)}',this.value,'text')">`;
    } else {
      input = `<input type="text" value="${escAttr(v == null ? '' : v)}"
                      oninput="Inspections.set('${escAttr(path)}',this.value,'text')">`;
    }
    return `<label class="${cls}"><span class="insp-label">${esc(label)}${note}</span>${input}</label>`;
  }

  // Postgres hands a `time` back as HH:MM:SS; <input type="time"> wants HH:MM.
  function hhmm(v) {
    if (!v) return '';
    const m = String(v).match(/^(\d{2}:\d{2})/);
    return m ? m[1] : '';
  }

  // Three states, because the paper has three: YES circled, NO circled, and —
  // far more often than either — neither. The two option labels come off the
  // Dropdown sheet like every other pick-list on this form.
  function boolHtml(path, v) {
    const yn = lookup('yes_no');
    const cur = v == null ? '' : String(!!v);
    return `
      <select onchange="Inspections.set('${escAttr(path)}',this.value,'bool')">
        <option value=""${cur === '' ? ' selected' : ''}>—</option>
        ${yn.map(o => `<option value="${o.value ? 'true' : 'false'}"${
          cur === String(!!o.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  function selectHtml(path, v, table) {
    const opts = lookup(table);
    return `
      <select onchange="Inspections.set('${escAttr(path)}',this.value,'sel')">
        <option value="">—</option>
        ${opts.map(o => `<option value="${escAttr(o.key)}"${
          o.key === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  // ── Serial numbers ─────────────────────────────────────────────────────────

  function serialsHtml(cfg) {
    const doc = S().doc;
    const kinds = lookup('equipment_kind');
    return `
      <div class="insp-scroll">
        <table class="insp-table">
          <thead><tr>
            <th>Equipment</th><th>As printed</th><th>Model</th><th>Serial No</th>
            <th>Version</th><th>Comments</th><th></th>
          </tr></thead>
          <tbody>
            ${doc.serials.map((r, i) => `
              <tr>
                <td>
                  <select onchange="Inspections.set('serials.${i}.equipment_key',this.value,'sel')">
                    ${kinds.map(k => `<option value="${escAttr(k.key)}"${
                      k.key === r.equipment_key ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}
                  </select>
                </td>
                <td><input type="text" value="${escAttr(r.label || '')}"
                           oninput="Inspections.set('serials.${i}.label',this.value,'text')"></td>
                <td><input type="text" value="${escAttr(r.model || '')}"
                           oninput="Inspections.set('serials.${i}.model',this.value,'text')"></td>
                <td><input type="text" value="${escAttr(r.serial_no || '')}"
                           oninput="Inspections.set('serials.${i}.serial_no',this.value,'text')"></td>
                <td><input type="text" value="${escAttr(r.version || '')}"
                           oninput="Inspections.set('serials.${i}.version',this.value,'text')"></td>
                <td><input type="text" value="${escAttr(r.comments || '')}"
                           oninput="Inspections.set('serials.${i}.comments',this.value,'text')"></td>
                <td><button class="insp-drop" title="Remove this row"
                            onclick="Inspections.removeSerial(${i})">×</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button onclick="Inspections.addSerial()">+ Equipment</button>
      <p class="small insp-muted">The panel is free text on paper and no two sheets name the same
        set, so the rows above are what the <code>${esc(cfg)}</code> sheet prints — add or drop
        one when the site does not match.</p>`;
  }

  // ── ALERT IDs / accumulator values ─────────────────────────────────────────

  function dataValuesHtml(sectionKey) {
    const phase = sectionKey === 'initial_data' ? 'initial' : 'final';
    const doc = S().doc;
    const block = doc.data && doc.data[phase];
    if (!block) return '';
    return `
      <h4 class="insp-block">ALERT ID's / Accumulator Values</h4>
      <div class="insp-scroll">
        <table class="insp-table">
          <thead><tr><th>ALERT ID</th><th>Label</th><th>Accumulator</th><th>Value</th><th></th></tr></thead>
          <tbody>
            ${(block.values || []).map((v, i) => `
              <tr>
                <td><input type="number" value="${escAttr(v.alert_id == null ? '' : v.alert_id)}"
                     oninput="Inspections.set('data.${phase}.values.${i}.alert_id',this.value,'num')"></td>
                <td><input type="text" value="${escAttr(v.label || '')}"
                     oninput="Inspections.set('data.${phase}.values.${i}.label',this.value,'text')"></td>
                <td><input type="number" step="any" value="${escAttr(v.accumulator == null ? '' : v.accumulator)}"
                     oninput="Inspections.set('data.${phase}.values.${i}.accumulator',this.value,'num')"></td>
                <td><input type="number" step="any" value="${escAttr(v.value == null ? '' : v.value)}"
                     oninput="Inspections.set('data.${phase}.values.${i}.value',this.value,'num')"></td>
                <td><button class="insp-drop" onclick="Inspections.removeValue('${phase}',${i})">×</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button onclick="Inspections.addValue('${phase}')">+ ALERT ID</button>`;
  }

  // ── Calibration grids ──────────────────────────────────────────────────────

  function calibrationsHtml(cfg, sectionKey) {
    const blocks = plannedCalibrations(cfg).filter(b => calSection(b.kind) === sectionKey);
    if (!blocks.length) return '';
    const doc = S().doc;
    return blocks.map(block => block.phases.map(phase => {
      const cols = (phase === 'final' && block.finalCols) || block.cols;
      const title = block.phases.length > 1
        ? `${phase === 'initial' ? 'Initial' : 'Final'} ${block.title}`
        : block.title;
      const rows = [];
      doc.calibrations.forEach((r, i) => {
        if (r.kind_key === block.kind && (r.phase || 'none') === phase) rows.push([r, i]);
      });
      return `
        <h4 class="insp-block">${esc(title)}</h4>
        ${block.note ? `<p class="small insp-muted">${esc(block.note)}</p>` : ''}
        <div class="insp-scroll">
          <table class="insp-table">
            <thead><tr>
              ${block.rows > 1 ? '<th>#</th>' : ''}
              ${cols.map(c => `<th>${esc((block.labels && block.labels[c]) || CAL_COLS[c])}</th>`).join('')}
              ${(block.extra || []).map(([, l]) => `<th>${esc(l)}</th>`).join('')}
              <th>Notes</th>
            </tr></thead>
            <tbody>
              ${rows.map(([r, i]) => `
                <tr>
                  ${block.rows > 1 ? `<td class="insp-ord">${r.ord}</td>` : ''}
                  ${cols.map(c => `<td>${calCellHtml(i, c, r)}</td>`).join('')}
                  ${(block.extra || []).map(([k]) => `
                    <td><input type="number" step="any" value="${escAttr(r.extra && r.extra[k] != null ? r.extra[k] : '')}"
                         oninput="Inspections.setExtra(${i},'${escAttr(k)}',this.value)"></td>`).join('')}
                  <td><input type="text" value="${escAttr(r.notes || '')}"
                       oninput="Inspections.set('calibrations.${i}.notes',this.value,'text')"></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }).join('')).join('');
  }

  function calCellHtml(i, col, row) {
    if (col === 'passed') {
      return boolHtml(`calibrations.${i}.passed`, row.passed);
    }
    return `<input type="number" step="any" value="${escAttr(row[col] == null ? '' : row[col])}"
                   oninput="Inspections.set('calibrations.${i}.${escAttr(col)}',this.value,'num')">`;
  }

  // The rule the sheet prints in words, next to a box nobody computes.
  function tipRuleHtml() {
    const doc = S().doc;
    if (!doc.rain_gauge || !tipRows(null).length) return '';
    return `
      <h4 class="insp-block">Adjustment</h4>
      <div class="insp-grid">
        <label class="insp-field"><span class="insp-label">Mean % error</span>
          <input type="number" step="any" id="insp-mean"
                 value="${escAttr(doc.rain_gauge.mean_pct_error == null ? '' : doc.rain_gauge.mean_pct_error)}"
                 oninput="Inspections.set('rain_gauge.mean_pct_error',this.value,'num')">
        </label>
        <label class="insp-field"><span class="insp-label">Threshold (%)
          <span class="insp-hint">recorded per visit, so changing it never rewrites what a past visit was judged against</span></span>
          <input type="number" step="any"
                 value="${escAttr(doc.rain_gauge.adjustment_threshold_pct == null ? 6 : doc.rain_gauge.adjustment_threshold_pct)}"
                 oninput="Inspections.set('rain_gauge.adjustment_threshold_pct',this.value,'num')">
        </label>
        <label class="insp-field"><span class="insp-label">Adjustment made?</span>
          ${boolHtml('rain_gauge.adjustment_made', doc.rain_gauge.adjustment_made)}
        </label>
      </div>
      <div id="insp-tip-rule">${tipRuleTextHtml()}</div>`;
  }

  function tipRuleTextHtml() {
    const doc = S().doc;
    const rg = doc && doc.rain_gauge;
    const mean = rg && rg.mean_pct_error;
    const th = adjustmentThreshold();
    if (mean == null) {
      return `<p class="small insp-muted">“Calibration adjustment should only be performed if the
        mean % error after 3 checks is greater than ${esc(th)}%.” — nothing to read it against yet.</p>`;
    }
    const over = Math.abs(Number(mean)) > th;
    return `<p class="small insp-rule ${over ? 'insp-rule-on' : ''}">
      Mean % error <strong>${esc(Number(mean).toFixed(2))}%</strong> against a
      ${esc(th)}% threshold — <strong>${over ? 'adjustment indicated' : 'no adjustment indicated'}</strong>.
      ${over ? 'The sheet asks for an adjustment only above this line, and this is above it.'
             : 'The sheet asks for an adjustment only above this line.'}</p>`;
  }

  // ── Fade margin ────────────────────────────────────────────────────────────

  function fadeMarginHtml() {
    const doc = S().doc;
    return `
      <h4 class="insp-block">Path Margin (dB)</h4>
      <p class="small insp-muted">The sheet's reference scale is Load 0–30 dB against Tips 1–11,
        recorded once as it was found (original) and again this visit.</p>
      ${['original', 'this_visit'].map(phase => {
        const rows = [];
        doc.fade_margin.forEach((r, i) => { if (r.phase === phase) rows.push([r, i]); });
        return `
          <h5 class="insp-subblock">${phase === 'original' ? 'Original' : 'This visit'}</h5>
          <div class="insp-scroll">
            <table class="insp-table">
              <thead><tr><th>Time</th><th>Load (dB)</th><th>Tips (TBRG)</th>
                <th>Received at base</th><th>Comments</th><th></th></tr></thead>
              <tbody>
                ${rows.length ? rows.map(([r, i]) => `
                  <tr>
                    <td><input type="time" value="${escAttr(hhmm(r.at_time))}"
                         oninput="Inspections.set('fade_margin.${i}.at_time',this.value,'time')"></td>
                    <td><input type="number" step="any" value="${escAttr(r.load_db == null ? '' : r.load_db)}"
                         oninput="Inspections.set('fade_margin.${i}.load_db',this.value,'num')"></td>
                    <td><input type="number" step="any" value="${escAttr(r.tips == null ? '' : r.tips)}"
                         oninput="Inspections.set('fade_margin.${i}.tips',this.value,'num')"></td>
                    <td>${boolHtml(`fade_margin.${i}.received_at_base`, r.received_at_base)}</td>
                    <td><input type="text" value="${escAttr(r.comments || '')}"
                         oninput="Inspections.set('fade_margin.${i}.comments',this.value,'text')"></td>
                    <td><button class="insp-drop" onclick="Inspections.removeFade(${i})">×</button></td>
                  </tr>`).join('')
                  : `<tr><td colspan="6" class="small insp-muted">No rows recorded.</td></tr>`}
              </tbody>
            </table>
          </div>
          <button onclick="Inspections.addFade('${phase}')">+ Reading</button>`;
      }).join('')}`;
  }

  // ── Data quality ───────────────────────────────────────────────────────────

  function dataQualityHtml() {
    const doc = S().doc;
    const opts = lookup('data_quality_rating');
    const LABEL = { rain: 'Rain', water_level: 'Water Level' };
    return `
      <div class="insp-scroll">
        <table class="insp-table">
          <thead><tr><th></th><th>On Arrival</th><th>On Departure</th><th>Comments</th></tr></thead>
          <tbody>
            ${doc.data_quality.map((r, i) => `
              <tr>
                <th class="insp-rowhead">${esc(LABEL[r.parameter] || r.parameter)}</th>
                <td>${ratingHtml(`data_quality.${i}.on_arrival_key`, r.on_arrival_key, opts)}</td>
                <td>${ratingHtml(`data_quality.${i}.on_departure_key`, r.on_departure_key, opts)}</td>
                <td><input type="text" value="${escAttr(r.comments || '')}"
                     oninput="Inspections.set('data_quality.${i}.comments',this.value,'text')"></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div id="insp-crossref">${crossRefTextHtml()}</div>`;
  }

  function ratingHtml(path, v, opts) {
    return `
      <select onchange="Inspections.set('${escAttr(path)}',this.value,'sel')">
        <option value="">—</option>
        ${opts.map(o => `<option value="${escAttr(o.key)}"${
          o.key === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  // The photo checklist's other half. `photos_taken` on meganet.inspection_admin
  // is a tick recording the *claim* that photos were taken, which is what the
  // paper sheet asks for and all this app could hold until #149; this is where
  // the photographs themselves go. Both stay: the tick is what the crew answered
  // on the sheet, and a visit whose photos are still on somebody's phone is a
  // different fact from one where nobody took any.
  function photosHtml() {
    return Attachments.sectionHtml({
      kind: 'inspection', id: S().doc.id, role: 'photo',
      label: 'Photos',
      note: 'The tick above records that photos were taken. These are the photos.',
    });
  }

  // The footer instruction, printed on every sheet.
  function crossRefHtml() {
    return `<p class="small insp-footnote">* sites on departure that are poor or have issues
      please complete Flood Warning Council Maintenance Project form</p>`;
  }

  // The instruction is a button once the visit is in the database, and only
  // then: `maintenance_activity.inspection_id` is a foreign key, so there has
  // to be a row for it to point at. An unsaved visit says so rather than
  // offering a link that would save a maintenance form pointing at nothing.
  function crossRefTextHtml() {
    const flagged = needsMaintenance();
    if (!flagged.length) return '';
    const doc = S().doc;
    const LABEL = { rain: 'Rain', water_level: 'Water Level' };
    return `
      <div class="insp-prompt">
        <strong>This visit meets the printed instruction at the foot of the sheet.</strong>
        <p class="small">${flagged.map(f =>
          `${esc(LABEL[f.parameter] || f.parameter)} left at <em>${esc(f.label)}</em>`).join(' · ')}
          — the sheet asks for a Flood Warning Council Maintenance Project form for a site that
          departs like this, and <code>meganet.maintenance_activity.inspection_id</code> is where
          that record points back to this one.</p>
        ${doc.id
          ? `<p class="small"><button class="primary" onclick="Inspections.raiseMaintenance()">
               Raise the Council Maintenance Tasks form for this visit</button></p>`
          : `<p class="small insp-muted">Save this inspection first — the link is a foreign key, so
               there has to be a saved visit for the maintenance form to point at. The
               <strong>Site Maintenance</strong> tab also lists every visit the instruction was
               printed for and nobody followed, so nothing is lost by raising it later.</p>`}
      </div>`;
  }

  // ── Not on this form ───────────────────────────────────────────────────────

  function notOnFormHtml(cfg) {
    const missing = sectionsNotOnForm(cfg);
    if (!missing.length) return '';
    return `
      <section class="panel insp-absent">
        <h4 class="insp-block">Not on this form</h4>
        <p class="small insp-muted">The ${esc(configLabel(cfg))} sheet does not print these, so
          there is nothing to fill in — and the database refuses a row for one, which is what keeps
          “this station has no gas bubbler” a different fact from “nobody filled the gas section
          in”.</p>
        <ul class="small insp-absent-list">
          ${missing.map(s => `<li><strong>${esc(s.label)}</strong> — ${esc(s.note)}</li>`).join('')}
        </ul>
      </section>`;
  }

  // ── The foot of the form ───────────────────────────────────────────────────

  function formFootHtml() {
    const s = S();
    return `
      <div class="panel insp-foot">
        <div id="insp-foot-status" class="small">${statusHtml()}</div>
        <div class="button-row">
          <button onclick="Inspections.saveDraft()">Save draft to this device</button>
          ${dbCanWrite()
            ? `<button class="primary" onclick="Inspections.save()" ${s.busy ? 'disabled' : ''}>
                 Save to the database</button>`
            : `<button class="primary" onclick="Auth.open()">Sign in to save</button>`}
          <button onclick="Inspections.close()">Close</button>
        </div>
      </div>`;
  }

  // ── Repainting ─────────────────────────────────────────────────────────────
  // A whole-tab repaint is for a structural change — a different configuration,
  // a row added, a record loaded. A keystroke never triggers one.

  // Through renderMain() rather than by writing #main-content directly, so the
  // Stations panes' chrome-height measurement still runs and the tab is
  // rendered the one way every other tab is. init() is idempotent, which is
  // what makes that safe to re-enter: both of its loads guard on their own
  // state, so a repaint never starts a second fetch.
  function repaint() {
    if (state.activeTab !== 'inspections') return;
    renderMain();
  }

  function paintDerived() {
    const rule = document.getElementById('insp-tip-rule');
    if (rule) rule.innerHTML = tipRuleTextHtml();
    const mean = document.getElementById('insp-mean');
    const doc = S().doc;
    if (mean && doc && doc.rain_gauge && document.activeElement !== mean) {
      mean.value = doc.rain_gauge.mean_pct_error == null ? '' : doc.rain_gauge.mean_pct_error;
    }
    const xref = document.getElementById('insp-crossref');
    if (xref) xref.innerHTML = crossRefTextHtml();
  }

  function say(msg) {
    S().msg = msg;
    ['insp-status', 'insp-foot-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = statusHtml();
    });
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────
  // localStorage, and deliberately not the database. The use this form was
  // written for is a crew on a tablet at a remote site with no signal, and a
  // draft that needs the network to exist is no draft at all.

  function readDrafts() {
    try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function writeDrafts(all) {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); return true; }
    catch (_) { return false; }
  }

  function scheduleDraft() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writeDraft(false); }, 1200);
  }

  function writeDraft(announce) {
    const s = S();
    if (!s.doc || !s.draftKey) return;
    const all = readDrafts();
    all[s.draftKey] = {
      doc: s.doc,
      stamp: s.stamp || null,
      config_key: s.doc.config_key,
      inspected_on: s.doc.inspected_on,
      title: s.doc.station_name || s.doc.cbm_no || 'Untitled visit',
      savedAt: Date.now(),
    };
    const ok = writeDrafts(all);
    if (announce) {
      say(ok ? { kind: 'ok', text: `Draft saved on this device at ${new Date().toLocaleTimeString()}.` }
             : { kind: 'error', text: 'This browser refused to store the draft — private mode, or storage is full.' });
    }
  }

  function dropDraft(key) {
    const all = readDrafts();
    delete all[key];
    writeDrafts(all);
  }

  // The timer is the only thing this tab starts, so it is the only thing it has
  // to stop. Flushed rather than dropped: leaving the tab mid-sentence must not
  // be the thing that loses the sentence.
  function stop() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeDraft(false); }
  }

  // ── Loading and saving ─────────────────────────────────────────────────────

  function loadRecent() {
    const s = S();
    if (!dbCanWrite()) { s.recent = null; return; }
    s.recentBusy = true;
    s.recentError = null;
    dbSelect('inspection?select=id,station_id,station_name,cbm_no,config_key,inspected_on,'
           + 'inspector,origin,updated_at&deleted_at=is.null&order=inspected_on.desc&limit=25')
      .then(rows => { s.recentBusy = false; s.recent = rows; repaint(); })
      .catch(err => {
        s.recentBusy = false;
        s.recent = [];
        s.recentError = `Could not read past inspections — ${(err && err.message) || err}`;
        repaint();
      });
  }

  function open(id) {
    const s = S();
    say({ kind: 'busy', text: 'Opening…' });
    dbRpc('inspection_doc', { p_id: id })
      .then(doc => {
        if (!doc) throw new Error('that inspection is no longer in the database');
        s.doc = ensureRows(doc);
        s.stamp = doc.updated_at || null;
        s.draftKey = `db:${id}`;
        s.suggestion = null;
        s.dirty = false;
        s.msg = null;
        repaint();
      })
      .catch(err => say({ kind: 'error', text: `Could not open it — ${(err && err.message) || err}` }));
  }

  // What actually goes over the wire. A section the crew opened and left blank
  // is a section nobody filled in, and 0009 spells that "no row" rather than "a
  // row of nulls" — the distinction the whole matrix exists to protect. So a
  // section object, a calibration row or a serial row with nothing in it is
  // dropped here rather than written. Nothing is lost: ensureRows() puts the
  // sheet's own empty grid back the next time the record is opened.
  function prunedDoc(doc) {
    const KEEP = { inspection_id: 1, phase: 1, ord: 1, kind_key: 1, parameter: 1,
                   equipment_key: 1, label: 1, units: 1 };
    const empty = obj => !obj || Object.keys(obj).every(k =>
      KEEP[k] || obj[k] == null || obj[k] === ''
      || (k === 'extra' && !Object.keys(obj[k] || {}).length));

    const out = Object.assign({}, doc);
    delete out.attachments;          // save_inspection does not write them (#149)
    ['power', 'rain_gauge', 'water_level', 'gas', 'radio', 'admin'].forEach(k => {
      if (empty(out[k])) out[k] = null;
    });
    out.serials = (doc.serials || []).filter(r => !empty(r));
    out.calibrations = (doc.calibrations || []).filter(r => !empty(r));
    out.data_quality = (doc.data_quality || []).filter(r => !empty(r));
    out.data = {};
    Object.keys(doc.data || {}).forEach(phase => {
      const block = doc.data[phase];
      const values = (block.values || []).filter(v => !empty(v));
      if (!empty(Object.assign({}, block, { values: undefined })) || values.length) {
        out.data[phase] = Object.assign({}, block, { values });
      }
    });
    return out;
  }

  async function save() {
    const s = S();
    if (s.busy || !s.doc) return;
    if (!s.doc.config_key) { say({ kind: 'error', text: 'Pick which form this is first.' }); return; }
    if (!s.doc.inspected_on) { say({ kind: 'error', text: 'An inspection needs the date it was carried out.' }); return; }

    s.busy = true;
    say({ kind: 'busy', text: 'Saving…' });

    let result;
    try {
      result = await dbRpc('save_inspection', {
        p_doc: prunedDoc(s.doc),
        p_expected_updated_at: s.doc.id ? s.stamp : null,
      });
    } catch (err) {
      s.busy = false;
      say({ kind: 'error', text: saveErrorText(err) });
      return;                    // the form, and everything typed into it, stands
    }

    s.busy = false;
    s.doc = ensureRows(result);
    s.stamp = result.updated_at || null;
    s.dirty = false;
    // The visit is in the database now, so the copy on this device is no longer
    // the only copy — and a stale draft that reappears next week is worse than
    // no draft at all.
    if (s.draftKey) dropDraft(s.draftKey);
    s.draftKey = `db:${s.doc.id}`;
    loadRecent();
    repaint();
    say({ kind: 'ok', text: `Saved at ${new Date().toLocaleTimeString()} — in the database, `
                          + `not just this tab. The draft on this device has been cleared.` });
  }

  // One message per way a save can fail, because "Error" is not an instruction.
  function saveErrorText(err) {
    if (err.conflict) {
      return `${err.message} Everything typed is still on screen and still in the draft on this `
           + `device — copy what you need, then reopen the inspection.`;
    }
    if (err.denied) {
      return Auth.isSignedIn()
        ? `Refused: ${Auth.email() || 'this address'} is not on the editors list, so the database `
          + `will not accept inspections from it. An administrator has to add it (docs/access.md). `
          + `Nothing was changed, and the draft on this device is safe.`
        : `Refused: not signed in, and the database does not accept anonymous writes. Sign in and `
          + `press Save again — the draft on this device is safe either way.`;
    }
    return `Not saved — ${err.message}. The draft on this device is safe; try again when the `
         + `datastore is reachable.`;
  }

  // ── The handlers the form names ────────────────────────────────────────────

  // Repaints the matches alone. Repainting the tab would take the search box —
  // and the caret in it — with them.
  function search(q) {
    S().query = q;
    const el = document.getElementById('insp-matches');
    if (el) el.innerHTML = matchesHtml();
  }

  function pick(stationId) {
    const s = S();
    const station = stationId
      ? ((state.data && state.data.stations) || []).find(x => x.id === stationId) || null
      : null;
    const sug = suggestConfig(station);
    s.suggestion = sug.why ? sug : null;
    const cfg = sug.key || (configs()[0] && configs()[0].key) || 'alert';
    s.doc = ensureRows(blankDoc(cfg, station));
    s.stamp = null;
    s.draftKey = `new:${cfg}:${stationId || 'unlisted'}:${Date.now()}`;
    s.dirty = false;
    s.msg = null;
    repaint();
  }

  // Changing the form changes which sections exist, and it also changes what
  // the sheet has printed on it before anyone writes anything — a different
  // Serial Numbers panel, different tip-test reference values. Both are
  // re-seeded, but only where nothing has been typed over them: correcting the
  // configuration on the picker must not be the thing that throws away a
  // half-filled form. Anything the crew has actually entered stays, including
  // in a section the new form does not print — where it is dropped, because the
  // database would refuse it and a hidden row that fails at save time is worse
  // than one that visibly went away now.
  function setConfig(key) {
    const s = S();
    if (!s.doc || key === s.doc.config_key) return;
    const was = s.doc.config_key;

    if (untouchedSerials(s.doc.serials, was)) s.doc.serials = [];
    ['power', 'rain_gauge', 'water_level', 'gas', 'radio', 'admin'].forEach(k => {
      if (untouchedSection(s.doc[k], defaultsFor(was, k))) s.doc[k] = null;
    });

    s.doc.config_key = key;
    s.suggestion = null;
    ensureRows(s.doc);
    s.dirty = true;
    scheduleDraft();
    repaint();
  }

  // Nothing but what the previous sheet put there.
  function untouchedSection(obj, defaults) {
    if (!obj) return true;
    return Object.keys(obj).every(k =>
      obj[k] == null || obj[k] === '' || obj[k] === defaults[k]);
  }

  function untouchedSerials(rows, cfg) {
    if (!rows || !rows.length) return true;
    const want = SERIALS[cfg] || [];
    if (rows.length !== want.length) return false;
    return rows.every((r, i) =>
      r.equipment_key === want[i][0] && r.label === want[i][1]
      && !r.model && !r.serial_no && !r.version && !r.comments);
  }

  function close() {
    const s = S();
    if (s.dirty) writeDraft(false);
    s.doc = null;
    s.stamp = null;
    s.draftKey = null;
    s.msg = null;
    loadRecent();
    repaint();
  }

  function addSerial() {
    const doc = S().doc;
    const ord = doc.serials.reduce((m, r) => Math.max(m, r.ord || 0), 0) + 1;
    doc.serials.push({ ord, equipment_key: 'other', label: '', model: '', serial_no: '', version: '', comments: '' });
    afterEdit();
    repaint();
  }

  function removeSerial(i) {
    const doc = S().doc;
    doc.serials.splice(i, 1);
    doc.serials.forEach((r, n) => { r.ord = n + 1; });
    afterEdit();
    repaint();
  }

  function addValue(phase) {
    const block = S().doc.data[phase];
    block.values.push({ ord: block.values.length + 1, alert_id: null, label: '', accumulator: null, value: null });
    afterEdit();
    repaint();
  }

  function removeValue(phase, i) {
    const block = S().doc.data[phase];
    block.values.splice(i, 1);
    block.values.forEach((v, n) => { v.ord = n + 1; });
    afterEdit();
    repaint();
  }

  function addFade(phase) {
    const doc = S().doc;
    const ord = doc.fade_margin.filter(r => r.phase === phase).length + 1;
    doc.fade_margin.push({ phase, ord, at_time: null, load_db: null, tips: null,
                           received_at_base: null, comments: '' });
    afterEdit();
    repaint();
  }

  function removeFade(i) {
    const doc = S().doc;
    const phase = doc.fade_margin[i].phase;
    doc.fade_margin.splice(i, 1);
    let n = 0;
    doc.fade_margin.forEach(r => { if (r.phase === phase) r.ord = ++n; });
    afterEdit();
    repaint();
  }

  // The long tail: kind-specific boxes no second kind prints. 0009 calls it a
  // long tail rather than a dumping ground, and the only one so far is the
  // Enviromon line's B. Offset and Zero Adj.
  function setExtra(i, key, raw) {
    const row = S().doc.calibrations[i];
    if (!row.extra || typeof row.extra !== 'object') row.extra = {};
    if (raw === '') delete row.extra[key];
    else row.extra[key] = Number(raw);
    afterEdit();
  }

  function resume(key) {
    const all = readDrafts();
    const d = all[key];
    if (!d) return;
    const s = S();
    s.doc = ensureRows(d.doc);
    s.stamp = d.stamp || null;
    s.draftKey = key;
    s.suggestion = null;
    s.dirty = false;
    s.msg = null;
    repaint();
  }

  function discard(key) {
    if (!window.confirm('Discard this draft? It is only on this device, so it cannot be recovered.')) return;
    dropDraft(key);
    repaint();
  }

  function retry() {
    S().refs = null;
    S().refsError = null;
    loadRefs();
  }

  function refresh() { loadRecent(); repaint(); }

  // The printed instruction at the foot of the sheet, followed. Assembled here
  // rather than serialised into the button's own attribute: the document is
  // right here, and a JSON blob inside an on*= attribute is a second escaping
  // layer nobody needs. The parameter named is the last flagged one, which on a
  // sheet with both is Water Level — the reading the crew is most likely to be
  // going back for.
  function raiseMaintenance() {
    const doc = S().doc;
    const flagged = needsMaintenance();
    if (!doc || !doc.id || !flagged.length) return;
    const worst = flagged[flagged.length - 1];
    Maintenance.startFrom({
      inspection_id: doc.id,
      station_id: doc.station_id || null,
      station_name: doc.station_name || '',
      cbm_no: doc.cbm_no || '',
      inspected_on: doc.inspected_on,
      parameter: worst.parameter,
      on_departure_label: worst.label,
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Registered from init(), never from the top level: constraint 5 on #113,
    // and checked by `npm run toplevel`. Keyed by name, so re-entering the tab
    // replaces the entry rather than stacking another.
    if (!registered) { registerTabTeardown('Inspections', stop); registered = true; }
    loadRefs();
    const s = S();
    if (dbCanWrite() && !s.recent && !s.recentBusy) loadRecent();
  }

  return {
    render, init, set, setExtra, search, pick, setConfig, close, save,
    saveDraft: () => writeDraft(true),
    open, resume, discard, retry, refresh, raiseMaintenance,
    addSerial, removeSerial, addValue, removeValue, addFade, removeFade,
  };
})();
