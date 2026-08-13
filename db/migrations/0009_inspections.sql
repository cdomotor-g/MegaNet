-- 0009_inspections.sql — The paper inspection sheets, as tables.
--
-- Epic #78 digitises `Inspection_sheets_for_printing.xlsx`: six station-inspection
-- forms and one council-maintenance form that field crews carry on paper. Epic
-- #122 backfills ~35 years of the same forms out of a second workbook. Both write
-- through this file, which is why it is #115 and why it is first.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0009_inspections.sql
--
-- Five decisions run through everything below. Each is a domain fact taken off
-- the sheets rather than invented here, and each is expensive to retrofit.
--
-- **1. There is one form, not six.** `Alert`, `Campbell DataLogger`, `Mace`,
-- `Gas Only`, `Base Station` and `DataLogger - old` are one family: a core of
-- sections with blocks added, removed or reworded per station configuration. The
-- workbook's own `Index` sheet says so — form identity is driven by the station's
-- telemetry type. So there is one `meganet.inspection` table and one set of
-- section tables, not six parallel schemas.
--
-- **2. "Does not apply" is data, not an absent row.** The trap this schema is
-- built to avoid is a wall of nullable columns in which "this station has no gas
-- bubbler" and "nobody filled the gas section in" look identical.
-- `meganet.inspection_config_section` is the answer: it records, per
-- configuration, which sections that form actually prints. A missing row in a
-- section table means *not recorded*; a missing row in the matrix means *not on
-- this form*, and a trigger refuses to write a section a configuration does not
-- have. The matrix was read off the six sheets cell by cell, not paraphrased —
-- `Mace` and `DataLogger - old` carry no Data Quality block and no photo
-- checklist, `Campbell DataLogger` has no radio section, and `Gas Only` has five
-- sections in total.
--
-- **3. The dropdowns are the ones on the `Dropdown` sheet.** Ten lookup tables,
-- labels transcribed verbatim from columns A–L, keys added because a label with a
-- trailing non-breaking space is not something to put in a foreign key. The
-- digitised form (#116, #117) reads its option lists from these tables; a
-- re-invented list in the UI is the bug this is here to prevent.
--
-- Internal enums that cannot grow — `initial`/`final`, `existing`/`replacement`
-- — are check constraints instead. That is the same distinction 0006 drew and
-- for the same reason: a check constraint that has to grow is a migration, and
-- these two cannot.
--
-- **4. Sixty-one column layouts collapse into one calibration table.** Every
-- sheet prints its calibration blocks differently — Alert has Druck plus Shaft
-- Encoder plus Rain Recalibration, Campbell has generic Initial/Final Calibration
-- grids used for all three, Base Station has decoder and receiver tests — but all
-- of them are the same seven columns: what was expected, where it started, where
-- it ended, what came out, the difference, the error, and whether it passed.
-- `meganet.inspection_calibration` is that shape, keyed by `kind`, and
-- `meganet.calibration_kind` maps each kind to the section it prints under. #122's
-- extractor has 61 layouts to flatten and this is what it flattens them into.
--
-- **5. The printed cross-reference becomes a foreign key.** Every inspection
-- sheet ends with *"sites on departure that are poor or have issues please
-- complete Flood Warning Council Maintenance Project form"*.
-- `meganet.maintenance_activity.inspection_id` is that sentence, and
-- `meganet.inspection_needs_maintenance` is the list of visits where it was
-- printed and not followed.
--
-- One more thing, stated here because it is a security decision rather than a
-- modelling one. **The inspection domain is not world-readable.** The station
-- list is, and readings are, but the Council Maintenance Tasks form carries
-- landowner names, emails and phone numbers, and inspection remarks carry site
-- access notes. The anon key is committed to this repo and published to GitHub
-- Pages. Everything this migration creates except the vocabularies is readable
-- only by an editor — see **Row level security** at the foot of the file, and
-- note that #118 and #128 inherit "signed in to see inspection history" from it.

-- ── The vocabularies, off the `Dropdown` sheet ────────────────────────────────
-- Ten tables of the same shape: a `key` that code and foreign keys use, an `ord`
-- that is the order the option appears in the spreadsheet column, and a `label`
-- that is the option's text exactly as it is printed on the form.
--
-- The labels are transcribed, not tidied. `TBRG 1 mm` has the space the sheet
-- has; `Poor (add comments below)` keeps its instruction. Two things *were*
-- normalised, both invisible: the trailing spaces on `Owner`, `Nitrogen` and
-- `Poor Quality `, and the non-breaking space every one of the 22 council names
-- ends with. A label that ends in U+00A0 is a label nobody can match by typing.

create table if not exists meganet.rain_instrument_type (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.rain_instrument_type is
  'Dropdown sheet column A — "Instrument type Rainfall". What the rain gauge is.';

insert into meganet.rain_instrument_type (key, ord, label) values
  ('tbrg_0_2mm', 1, 'TBRG 0.2mm'),
  ('tbrg_0_5mm', 2, 'TBRG 0.5mm'),
  ('tbrg_1mm',   3, 'TBRG 1 mm'),
  ('other',      4, 'Other')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.condition_rating (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.condition_rating is
  'Dropdown sheet column B — "Condition". Used by the Council form for each of its three asset panels and for gauge boards.';

insert into meganet.condition_rating (key, ord, label) values
  ('good', 1, 'Good'),
  ('fair', 2, 'Fair'),
  ('poor', 3, 'Poor (add comments below)')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.asset_owner (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.asset_owner is
  'Dropdown sheet column C — "Owner". Who owns the instrument, which is the question behind every maintenance conversation with a council.';

insert into meganet.asset_owner (key, ord, label) values
  ('council', 1, 'Council'),
  ('bureau',  2, 'Bureau'),
  ('unknown', 3, 'Unknown')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.wl_instrument_type (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.wl_instrument_type is
  'Dropdown sheet column D — "WL instrument type". What measures water level.';

insert into meganet.wl_instrument_type (key, ord, label) values
  ('ott',          1, 'OTT'),
  ('hs40',         2, 'HS40'),
  ('amazon',       3, 'Amazon'),
  ('nitrogen',     4, 'Nitrogen'),
  ('water_log',    5, 'Water Log'),
  ('hs40_compact', 6, 'HS40 compact')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.comms_method (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.comms_method is
  'Dropdown sheet column E — "Comms Method". How the site reports. Deliberately not merged with meganet.protocol: that is what a reading was decoded from, this is what a person ticked on a form.';

insert into meganet.comms_method (key, ord, label) values
  ('alert1',    1, 'Alert1'),
  ('satellite', 2, 'Satellite'),
  ('cellular',  3, 'Cellular'),
  ('other',     4, 'Other')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.comms_equipment (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.comms_equipment is
  'Dropdown sheet column F — "Comms equipment". The box doing the reporting.';

insert into meganet.comms_equipment (key, ord, label) values
  ('elpro_v3',        1, 'ELPROV3'),
  ('campbells_logger', 2, 'Campbells Logger'),
  ('other',           3, 'Other')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

create table if not exists meganet.power_supply (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.power_supply is
  'Dropdown sheet column H — "Power". Column G is blank on the sheet; the gap is the spreadsheet''s, not a missing list.';

insert into meganet.power_supply (key, ord, label) values
  ('mains',          1, 'Mains'),
  ('solar_battery',  2, 'Solar and Battery')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- Column I. The one list that is *not* how the data is stored: a yes/no answer
-- that may also be unanswered is exactly a nullable boolean, and inventing a
-- two-row foreign key to say so would make every `is gauge level?` on the form a
-- join. The table exists because #116 renders these as pick-lists and should draw
-- its two option labels from the sheet like every other list here.
create table if not exists meganet.yes_no (
  key    text primary key,
  ord    integer not null,
  label  text    not null,
  value  boolean not null
);

comment on table meganet.yes_no is
  'Dropdown sheet column I. Option labels for the form UI. Stored answers are nullable booleans on the section tables, not references to this — null is "not recorded", which the sheet has no cell for and the schema must.';

insert into meganet.yes_no (key, ord, label, value) values
  ('yes', 1, 'Yes', true),
  ('no',  2, 'No',  false)
on conflict (key) do update set ord = excluded.ord, label = excluded.label, value = excluded.value;

create table if not exists meganet.data_quality_rating (
  key    text primary key,
  ord    integer not null,
  label  text    not null,
  -- Whether a departure rating of this value is one the printed instruction at
  -- the foot of every inspection sheet asks a maintenance form to be raised for.
  -- The sheet says "poor or have issues"; missing and poor are the two that mean
  -- the data did not arrive usable.
  needs_maintenance boolean not null default false
);

comment on table meganet.data_quality_rating is
  'Dropdown sheet column J — the five-value rating each inspection and each maintenance activity gives rain and water level, on arrival and on departure.';

insert into meganet.data_quality_rating (key, ord, label, needs_maintenance) values
  ('missing_record', 1, 'Missing Record', true),
  ('non_verified',   2, 'Non verified',   false),
  ('poor_quality',   3, 'Poor Quality',   true),
  ('fair_quality',   4, 'Fair Quality',   false),
  ('good_quality',   5, 'Good Quality',   false)
on conflict (key) do update set ord = excluded.ord, label = excluded.label,
                                needs_maintenance = excluded.needs_maintenance;

create table if not exists meganet.council (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.council is
  'Dropdown sheet column L — the 22 Queensland councils the flood-warning network is maintained with. A row here, not a migration, when a boundary changes.';

insert into meganet.council (key, ord, label) values
  ('bundaberg',        1,  'Bundaberg'),
  ('burdekin',         2,  'Burdekin'),
  ('cairns',           3,  'Cairns'),
  ('cassowary_coast',  4,  'Cassowary Coast'),
  ('central_highlands', 5, 'Central Highlands'),
  ('fraser_coast',     6,  'Fraser Coast'),
  ('gladstone',        7,  'Gladstone'),
  ('gold_coast',       8,  'Gold Coast'),
  ('goondiwindi',      9,  'Goondiwindi'),
  ('hinchinbrook',     10, 'Hinchinbrook'),
  ('logan',            11, 'Logan'),
  ('mackay',           12, 'Mackay'),
  ('moreton_bay',      13, 'Moreton Bay'),
  ('murweh',           14, 'Murweh'),
  ('noosa',            15, 'Noosa'),
  ('rockhampton',      16, 'Rockhampton'),
  ('scenic_rim',       17, 'Scenic Rim'),
  ('southern_downs',   18, 'Southern Downs'),
  ('sunshine_coast',   19, 'Sunshine Coast'),
  ('townsville',       20, 'Townsville'),
  ('western_downs',    21, 'Western Downs'),
  ('whitsunday',       22, 'Whitsunday')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- Not from the `Dropdown` sheet — this one is read off the six Serial Numbers
-- panels, which between them name twenty-one distinct pieces of equipment and
-- name them differently on different sheets ("Canister and version" on Alert and
-- Gas Only, "Logger" on Campbell and DataLogger - old, "MACE" on Mace). The key
-- is what the schema calls it; `label` is the most common printed wording, and
-- `meganet.inspection_serial.label` carries the sheet's own words when they
-- differ or when the equipment is `other`.
create table if not exists meganet.equipment_kind (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.equipment_kind is
  'What a serial number is for. Read off the six Serial Numbers panels rather than the Dropdown sheet — those panels are free text on paper and this is what they say.';

insert into meganet.equipment_kind (key, ord, label) values
  ('canister',             1,  'Canister and version'),
  ('ert_a2',               2,  'ERT A2 (F/W build #)'),
  ('logger',               3,  'Logger'),
  ('mace',                 4,  'MACE'),
  ('modem',                5,  'Modem'),
  ('antenna',              6,  'Antenna'),
  ('sim',                  7,  'SIM'),
  ('receiver',             8,  'Receiver and version'),
  ('decoder',              9,  'Decoder and version'),
  ('tbrg',                 10, 'TBRG'),
  ('water_level_sensor',   11, 'Water Level Sensor'),
  ('river_sensor',         12, 'River Sensor'),
  ('shaft_encoder',        13, 'Shaft Encoder'),
  ('pressure_transmitter', 14, 'Pressure Transmitter'),
  ('bubble_unit',          15, 'Bubble Unit'),
  ('gas_druck',            16, 'Gas Druck'),
  ('solar_panel',          17, 'Solar Panel'),
  ('solar_regulator',      18, 'Solar Regulator'),
  ('power_supply',         19, 'Power Supply'),
  ('pha',                  20, 'PHA'),
  ('key_number',           21, 'Key #'),
  ('other',                22, 'Other')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- ── The form, as data ────────────────────────────────────────────────────────
-- Decision 1 and decision 2, made structural. Three tables: the configurations,
-- the sections, and which configuration prints which section.
--
-- This is what #116 builds its form from — one render driven by a matrix, rather
-- than six hand-written layouts that drift apart — and it is what makes "this
-- section does not apply here" a fact the database holds rather than a comment.

create table if not exists meganet.inspection_config (
  key    text primary key,
  ord    integer not null,
  label  text    not null,
  -- The sheet in Inspection_sheets_for_printing.xlsx this came off, so a
  -- disagreement between form and schema can be settled by opening the workbook.
  sheet  text    not null default '',
  note   text    not null default ''
);

comment on table meganet.inspection_config is
  'The six station configurations, one per inspection sheet. The workbook''s Index sheet is explicit that form identity follows the station''s telemetry type; this is that axis.';

insert into meganet.inspection_config (key, ord, label, sheet, note) values
  ('alert',               1, 'ALERT',              'Alert',
   'ALERT-canister telemetry, radio/UHF reporting. The only station form with a radio section.'),
  ('campbell_datalogger', 2, 'Campbell Data Logger', 'Campbell DataLogger',
   'Campbell logger, modem reporting. Adds Sends? and RSSI to both data blocks; reports to a base station, so no radio section of its own.'),
  ('mace',                3, 'Mace',               'Mace',
   'Telephone telemetry. DP counter, PHA, voltage at the phone socket. No radio, no data-quality block, no photo checklist.'),
  ('gas_only',            4, 'Gas Only',           'Gas Only',
   'Gas-bubbler-only site. Five sections: details, serials, gas, a single staff gauge line, remarks. Two forms print per A4 sheet.'),
  ('base_station',        5, 'ALERT Base Station', 'Base Station',
   'Repeater/receiver infrastructure, no sensors. Antenna tests, one decoder test and two receiver tests. Its details block is headed "Base Station Details".'),
  ('datalogger_old',      6, 'Data Logger (old)',  'DataLogger - old',
   'Legacy logger variant, superseded by Campbell but still in use. Hybrid of Alert and Campbell; no radio, no data-quality block, no photo checklist.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label,
                                sheet = excluded.sheet, note = excluded.note;

create table if not exists meganet.inspection_section (
  key    text primary key,
  ord    integer not null,
  label  text    not null,
  -- The table this section's answers live in. Empty for the two sections that
  -- live on meganet.inspection itself.
  home   text    not null default '',
  note   text    not null default ''
);

comment on table meganet.inspection_section is
  'The fourteen banner-headed blocks the six sheets are assembled from, in print order. `home` names the table each one''s answers land in.';

insert into meganet.inspection_section (key, ord, label, home, note) values
  ('station_details',  1,  'Station Details',            'inspection',
   'Headed "Base Station Details" on the base-station sheet. Name, CBM No, coordinates, date, initials, and the two office ticks.'),
  ('serial_numbers',   2,  'Serial Numbers',             'inspection_serial',
   'A list, not a fixed set of fields — every sheet names a different subset of equipment.'),
  ('initial_data',     3,  'Initial Data',               'inspection_data',
   'On arrival. phase = initial.'),
  ('battery',          4,  'Battery',                    'inspection_power',
   'Existing and replacement battery, plus consumption figures. Shares a table with the supply section — they are one power story and always print together.'),
  ('power_supply',     5,  'Solar Panel / Mains Supply', 'inspection_power',
   'Same table as the battery section, for the same reason.'),
  ('rain_gauge',       6,  'Rain',                       'inspection_rain_gauge',
   'The TBRG checks. The tip test itself is calibration rows.'),
  ('water_level',      7,  'River / Water Level',        'inspection_water_level',
   'On the Gas Only sheet this is one printed line — "Staff Gauge:" — and nothing else; the matrix records that with a variant note rather than a section of its own.'),
  ('gas',              8,  'Gas',                        'inspection_gas',
   'Cylinders, compressor, leak test, purge, consumption.'),
  ('radio',            9,  'Antenna Tests',              'inspection_radio',
   'Alert and Base Station only. Fade margin rows hang off it on the Alert sheet.'),
  ('base_tests',       10, 'Decoder & Receiver Tests',   'inspection_calibration',
   'Base Station only: one decoder test and two receiver tests, as calibration rows.'),
  ('final_data',       11, 'Final Data',                 'inspection_data',
   'At end of visit. phase = final. Headed "Final Reset Data" on Alert and "Data at end of visit" on Mace.'),
  ('data_quality',     12, 'Data Quality',               'inspection_data_quality',
   'Alert and Campbell only. Rain and water level, each rated on arrival and on departure.'),
  ('remarks',          13, 'Remarks',                    'inspection',
   'Free text. The only section on all six sheets besides the details block.'),
  ('admin_checklist',  14, 'Photos & Admin',             'inspection_admin',
   'The footer tick row. Base Station prints five of the nine columns; Mace, Gas Only and DataLogger - old print none.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label,
                                home = excluded.home, note = excluded.note;

create table if not exists meganet.inspection_config_section (
  config_key   text    not null references meganet.inspection_config (key) on delete cascade,
  section_key  text    not null references meganet.inspection_section (key) on delete cascade,
  ord          integer not null,
  -- What this configuration does differently with the section. Empty when it
  -- prints it as the core describes.
  variant_note text    not null default '',
  primary key (config_key, section_key)
);

comment on table meganet.inspection_config_section is
  'Which sections each configuration''s form actually prints, in its own order. A row absent here means the section is not on that form — which is a different fact from a section table having no row, and the distinction is the whole point.';

-- Read off the six sheets cell by cell. Where this disagrees with a prose
-- summary of the workbook, the sheets won: Mace and DataLogger - old print no
-- Data Quality block and no photo checklist, and DataLogger - old has no radio
-- section despite the Index sheet's description saying otherwise (the Index
-- reuses the ALERT wording for all three of its entries — the workbook's own
-- copy-paste, marked [sic] in #78's transcription).
insert into meganet.inspection_config_section (config_key, section_key, ord, variant_note) values
  ('alert', 'station_details', 1, ''),
  ('alert', 'serial_numbers',  2, 'Canister and version, ERT A2 (F/W build #), TBRG, Water Level Sensor, Bubble Unit, Key #, Power Supply.'),
  ('alert', 'initial_data',    3, 'Rain, River (staff gauge and accumulator values), Battery, Logger time, ALERT IDs.'),
  ('alert', 'battery',         4, ''),
  ('alert', 'power_supply',    5, 'Solar LED noted on arrival and at departure; static, consumption, charge and trickle currents; individual / combined.'),
  ('alert', 'rain_gauge',      6, 'HS 10.0mm / Rimco 10.4mm reference. Rain recalibration accumulator block.'),
  ('alert', 'water_level',     7, 'Druck calibration (DPI pump / test set / logger display / error in m) and a shaft encoder check.'),
  ('alert', 'gas',             8, ''),
  ('alert', 'radio',           9, 'Full block: TX size, forward and reflected power, SWR, frequency, existing and replacement antenna, and the path/fade margin table.'),
  ('alert', 'final_data',     10, 'Headed "Final Reset Data". Includes the staff gauge survey question and the Enviromon calibration line.'),
  ('alert', 'data_quality',   11, ''),
  ('alert', 'remarks',        12, ''),
  ('alert', 'admin_checklist', 13, 'All nine columns.'),

  ('campbell_datalogger', 'station_details', 1, ''),
  ('campbell_datalogger', 'serial_numbers',  2, 'Headed "Model and Serial Numbers": logger (OS & program), modem, antenna & SIM, TBRG, solar panel, solar regulator, river sensor, bubble unit, gas Druck.'),
  ('campbell_datalogger', 'initial_data',    3, 'Adds Sends? (Y/N) and RSSI.'),
  ('campbell_datalogger', 'battery',         4, 'Lithium battery minimum 2.90 V noted on the sheet.'),
  ('campbell_datalogger', 'power_supply',    5, ''),
  ('campbell_datalogger', 'rain_gauge',      6, 'Accuracy check method is the HS field calibration tool, with the 653ml/200mm-hr and 730ml/100mm-hr nozzle table. Rimco 20.2mm (101 tips), HS 20.8mm (104 tips).'),
  ('campbell_datalogger', 'water_level',     7, 'Adds "current WL entered for IP logger?" and a staff gauge range.'),
  ('campbell_datalogger', 'gas',             8, ''),
  ('campbell_datalogger', 'final_data',      9, 'Adds "check data coming in?" and "logger cleared?". Modmax RSSI legend: -105dB weak, -105 to -95dB OK, above -95dB good.'),
  ('campbell_datalogger', 'data_quality',   10, ''),
  ('campbell_datalogger', 'remarks',        11, 'Headed "Comments".'),
  ('campbell_datalogger', 'admin_checklist', 12, 'All nine columns.'),

  ('mace', 'station_details', 1, ''),
  ('mace', 'serial_numbers',  2, 'MACE, TBRG, Shaft Encoder, Pressure Transmitter (or DP), Solar Panel, PHA, Bubble Unit.'),
  ('mace', 'initial_data',    3, 'Staff gauge, Mace River, Mace Rain, Counter (DP).'),
  ('mace', 'battery',         4, 'MACE voltage and under load, sleep / operating / interrupt consumption, DP voltage and under load, phone voltage at socket.'),
  ('mace', 'power_supply',    5, ''),
  ('mace', 'rain_gauge',      6, 'Rimco calibration tool required when using water from a standard rain measure; expected 9.7mm (9.707).'),
  ('mace', 'water_level',     7, 'Headed "River (Analogue)": capillary line purge, DP delay up/down, DP contacts, DP counter cleaned and adjusted.'),
  ('mace', 'gas',             8, 'Adds "spare cylinder at station?".'),
  ('mace', 'final_data',      9, 'Headed "Data at end of visit". Adds the final modem test via office.'),
  ('mace', 'remarks',        10, 'Two blocks: remarks, and comments for the next visit.'),

  ('gas_only', 'station_details', 1, 'Station Name, CBM No, Alert ID, Date. No coordinates and no initials.'),
  ('gas_only', 'serial_numbers',  2, 'Canister and version, TBRG, Shaft Encoder, Pressure Transmitter, Solar Panel, Bubble Unit, Power Supply.'),
  ('gas_only', 'gas',             3, ''),
  ('gas_only', 'water_level',     4, 'One printed line — "Staff Gauge:" — and nothing else. Only meganet.inspection_water_level.staff_gauge_note applies.'),
  ('gas_only', 'remarks',         5, ''),

  ('base_station', 'station_details', 1, 'Headed "Base Station Details": name, CBM No, date, time. No coordinates.'),
  ('base_station', 'serial_numbers',  2, 'Two receivers and a decoder, each with a version.'),
  ('base_station', 'radio',           3, 'Antenna tests only — TX size, frequency, forward and reflected power, for existing and replacement antenna. No SWR column and no fade margin table.'),
  ('base_station', 'base_tests',      4, 'One decoder test (expected 24.0 V +/- 3.0 V) and two receiver tests (frequency, power supplied from decoder, measured value).'),
  ('base_station', 'remarks',         5, ''),
  ('base_station', 'admin_checklist', 6, 'Five columns only: Photos, Excel, WO Comp, Meters, EAMS other.'),

  ('datalogger_old', 'station_details', 1, ''),
  ('datalogger_old', 'serial_numbers',  2, 'Logger, modem, bubble unit, TBRG, solar panel, shaft encoder, pressure transmitter, other.'),
  ('datalogger_old', 'initial_data',    3, 'Rain, battery, river (staff gauge and logger value), gas pressure.'),
  ('datalogger_old', 'battery',         4, 'Lithium battery minimum 2.90 V; step-up voltage on the supply block.'),
  ('datalogger_old', 'power_supply',    5, 'Charge LED noted on arrival and at departure.'),
  ('datalogger_old', 'rain_gauge',      6, 'Rimco 20.2mm (101 tips), HS 20.8mm (104 tips).'),
  ('datalogger_old', 'water_level',     7, ''),
  ('datalogger_old', 'gas',             8, 'Labels differ: "Orifice Checked" and "Gas Line Purged".'),
  ('datalogger_old', 'final_data',      9, 'Adds the final modem test via office and "logger dump and cleared?".'),
  ('datalogger_old', 'remarks',        10, 'Footer references .xls and SitesDb.')
on conflict (config_key, section_key) do update
  set ord = excluded.ord, variant_note = excluded.variant_note;

-- The calibration kinds, and which section each prints under. Decision 4: this
-- is what lets one table hold every calibration block on every sheet, and what
-- lets the applicability guard work on a table whose section depends on its row.
create table if not exists meganet.calibration_kind (
  key          text    primary key,
  ord          integer not null,
  label        text    not null,
  section_key  text    not null references meganet.inspection_section (key),
  note         text    not null default ''
);

comment on table meganet.calibration_kind is
  'What a meganet.inspection_calibration row is a calibration of, and which form section it prints under. A new kind is a row here — #122 will meet layouts this list has not seen.';

insert into meganet.calibration_kind (key, ord, label, section_key, note) values
  ('rain_tip_test',       1, 'TBRG tip test',        'rain_gauge',
   'Three checks, ord 1-3, before and after adjustment. The mean %% error across them is what the 6%% rule is read against.'),
  ('rain_recalibration',  2, 'Rain recalibration',   'rain_gauge',
   'Alert only: start accumulator, end accumulator, result.'),
  ('druck',               3, 'Druck calibration',    'water_level',
   'DPI pump against the test set or the logger display; the answer is an error in metres.'),
  ('shaft_encoder',       4, 'Shaft encoder',        'water_level',
   'Revolutions, start value, end value, result. One full revolution = 36.5 increments on the Campbell sheet.'),
  ('enviromon',           5, 'Enviromon calibration', 'final_data',
   'Alert only, printed inside the Final Reset Data block: date, time, div, B. offset, zero adj. The last three live in `extra`.'),
  ('decoder_test',        6, 'Decoder test',         'base_tests',
   'Base Station: expected output 24.0 V +/- 3.0 V against a measured value.'),
  ('receiver_test',       7, 'Receiver test',        'base_tests',
   'Base Station, twice (ord 1 and 2): frequency, power supplied from the decoder, measured value.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label,
                                section_key = excluded.section_key, note = excluded.note;

create table if not exists meganet.attachment_role (
  key    text primary key,
  ord    integer not null,
  label  text    not null
);

comment on table meganet.attachment_role is
  'What an attachment is. `canister_config` exists because the Council form''s ALERT CANISTER CONFIGURATION panel is a pasted screenshot of a terminal dump in the one filled-in example — an image, not a field set, and the clearest signal in the workbook that this domain needs attachments.';

insert into meganet.attachment_role (key, ord, label) values
  ('photo',           1, 'Site photo'),
  ('canister_config', 2, 'ALERT canister configuration dump'),
  ('gauge_board',     3, 'Gauge board or benchmark photo'),
  ('document',        4, 'Scanned form or document'),
  ('other',           5, 'Other')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

-- ── The visit ────────────────────────────────────────────────────────────────
-- One row per station visit. Everything on the sheet that is not inside a
-- banner-headed block is here: the details panel at the top, and the remarks at
-- the bottom.
--
-- `station_id` is a real foreign key, unlike meganet.reading's, and the reason
-- the two differ is worth stating. A reading arrives from an address, possibly
-- before anyone has told MegaNet the station exists; refusing it would lose data
-- nobody can re-send. An inspection is typed by a person who chose a station
-- from a list. It is still nullable — a base station or a site being visited for
-- the first time may not be in the list yet — and `station_name` and `cbm_no`
-- carry what the form said either way, so an unmatched visit is still a complete
-- record. #125 backfills the column for #122's historical rows.

create table if not exists meganet.inspection (
  id             uuid        primary key default gen_random_uuid(),

  station_id     text        references meganet.station (id),
  config_key     text        not null references meganet.inspection_config (key),

  -- What the form says, kept whether or not station_id resolved. A station is
  -- renamed and a form from 2004 still has to read as it was written.
  station_name   text        not null default '',
  cbm_no         text        not null default '',
  alert_id       integer,
  lat            numeric,
  lon            numeric,

  inspected_on   date        not null,
  -- "Initials" on the sheet; a name where somebody wrote one.
  inspector      text        not null default '',

  -- The two office ticks: "Office - tick here after SitesDb & HDB/MIS entry",
  -- Last Visit and Stock changes. Null is not-recorded, which on a paper form is
  -- the overwhelmingly common state of these two boxes.
  office_last_visit    boolean,
  office_stock_changes boolean,

  -- Printed at the top of the Mace, Campbell and DataLogger - old sheets, above
  -- and outside every banner, which is why they are here and not in the rain
  -- gauge section.
  rain_gauge_type   text     not null default '',
  rain_gauge_serial text     not null default '',

  remarks        text        not null default '',
  -- Mace prints a second free-text block: "Enter comments for next visit".
  next_visit_comments text  not null default '',

  -- Where the row came from. 'form' is #116; 'import' is #122's extractor, and
  -- the column exists now so that a historical row is never mistaken for one a
  -- person typed today.
  origin         text        not null default 'form'
                             check (origin in ('form', 'import')),
  -- #124's staging identity, so a re-run of the extractor updates rather than
  -- duplicates. Null for anything typed into the form.
  source_ref     text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text,
  deleted_at     timestamptz
);

comment on table meganet.inspection is
  'One station visit, one row. The details panel and the remarks; every banner-headed block is a section table hanging off this one.';
comment on column meganet.inspection.config_key is
  'Which of the six forms this visit was recorded on. It decides which sections may exist — see meganet.inspection_config_section.';
comment on column meganet.inspection.station_id is
  'Nullable on purpose: a first visit, or a base station not in the list. station_name and cbm_no carry the form''s own words regardless.';
comment on column meganet.inspection.origin is
  'form = typed into MegaNet. import = backfilled from the historical workbook by #122. A historical row must never read as one somebody entered today.';

create index if not exists inspection_station_idx on meganet.inspection
  (station_id, inspected_on desc) where deleted_at is null;
create index if not exists inspection_date_idx on meganet.inspection
  (inspected_on desc) where deleted_at is null;
create index if not exists inspection_config_idx on meganet.inspection (config_key);
-- #124 re-runs its extractor; this is what makes the second run an update.
create unique index if not exists inspection_source_ref_idx on meganet.inspection
  (source_ref) where source_ref is not null;

drop trigger if exists inspection_touch_updated_at on meganet.inspection;
create trigger inspection_touch_updated_at before update on meganet.inspection
  for each row execute function meganet.touch_updated_at();

-- ── Is this section even on this form? ───────────────────────────────────────
-- Decision 2, enforced. Every section table below carries this trigger, and it
-- is the difference between a schema that *documents* applicability and one that
-- holds it.
--
-- The section is a constant passed as the trigger argument for eleven of the
-- thirteen. Two cannot say it that way — meganet.inspection_data is
-- `initial_data` or `final_data` depending on its own phase, and
-- meganet.inspection_calibration's section is a property of its kind — so each
-- of those has a four-line guard of its own further down. Note why they cannot
-- simply read a generated `section_key` off the row: a stored generated column
-- is computed *after* BEFORE triggers run, so in here it is still null.

create or replace function meganet.inspection_section_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text := nullif(tg_argv[0], '');
  v_config  text;
begin
  if v_section is null then
    raise exception 'trigger % on % was given no section to check', tg_name, tg_table_name
      using errcode = '22023';
  end if;

  select i.config_key into v_config
    from meganet.inspection i
   where i.id = (pg_catalog.to_jsonb(new) ->> 'inspection_id')::uuid;

  if v_config is null then
    -- The foreign key will say this better than we can.
    return new;
  end if;

  if not exists (select 1 from meganet.inspection_config_section cs
                  where cs.config_key = v_config and cs.section_key = v_section) then
    raise exception
      'the % form has no % section, so this inspection cannot carry one', v_config, v_section
      using errcode = '22023',
            hint    = 'meganet.inspection_config_section lists what each configuration prints; '
                      'if the form really does have this section, add the row there first';
  end if;

  return new;
end;
$$;

comment on function meganet.inspection_section_guard() is
  'Refuses a section row for a configuration whose form does not print that section. The reason "not applicable" and "not filled in" are different states in this schema rather than the same null.';

-- ── The sections ─────────────────────────────────────────────────────────────

-- Serial Numbers. A list rather than a fixed field set, because every sheet
-- names a different subset and two of them name the same box differently.
create table if not exists meganet.inspection_serial (
  inspection_id  uuid    not null references meganet.inspection (id) on delete cascade,
  ord            integer not null,
  equipment_key  text    not null references meganet.equipment_kind (key),
  -- The sheet's own wording, when it differs from the equipment label or when
  -- equipment_key is 'other'.
  label          text    not null default '',
  model          text    not null default '',
  serial_no      text    not null default '',
  -- "and version", "F/W build #", "OS & Program" — the same column on three
  -- sheets under three names.
  version        text    not null default '',
  comments       text    not null default '',
  primary key (inspection_id, ord)
);

comment on table meganet.inspection_serial is
  'The Serial Numbers panel, one row per piece of equipment named on the sheet.';

drop trigger if exists inspection_serial_section on meganet.inspection_serial;
create trigger inspection_serial_section before insert or update on meganet.inspection_serial
  for each row execute function meganet.inspection_section_guard('serial_numbers');

-- Initial Data and Final Data. One table, two phases: the two blocks are the
-- same columns read twice, which is exactly what the sheets print.
create table if not exists meganet.inspection_data (
  inspection_id  uuid not null references meganet.inspection (id) on delete cascade,
  phase          text not null check (phase in ('initial', 'final')),
  -- Which of the two sections this row is, spelled the way
  -- meganet.inspection_section spells it. Generated, so it cannot disagree with
  -- the phase, and useful for joining the matrix; the guard below computes it
  -- separately because a stored generated column is not filled in yet when a
  -- BEFORE trigger runs.
  section_key    text generated always as (phase || '_data') stored,

  at_time        time,
  -- Alert and Campbell print the logger's own clock next to the wall clock, so
  -- that drift is visible on the form.
  logger_time    time,

  rain_logger          numeric,
  river_staff_gauge_m  numeric,
  river_logger         numeric,
  battery_v            numeric,
  gas_pressure_kpa     numeric,
  -- Campbell only.
  sends                boolean,
  rssi_dbm             numeric,
  -- Mace only: the differential-pressure counter.
  dp_counter           numeric,

  -- Final block only on every sheet that has them.
  logger_cleared          boolean,
  modem_test_via_office   boolean,
  data_coming_in          boolean,
  staff_gauge_survey_done boolean,

  comments       text not null default '',
  primary key (inspection_id, phase)
);

comment on table meganet.inspection_data is
  'Readings on arrival (phase = initial) and at end of visit (phase = final). One shape, because the sheets print one shape twice.';

create or replace function meganet.inspection_data_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text := new.phase || '_data';
  v_config  text;
begin
  select i.config_key into v_config
    from meganet.inspection i where i.id = new.inspection_id;
  if v_config is null then
    return new;   -- the foreign key is about to say it better
  end if;

  if not exists (select 1 from meganet.inspection_config_section cs
                  where cs.config_key = v_config and cs.section_key = v_section) then
    raise exception 'the % form has no % section, so this inspection cannot carry one',
      v_config, v_section
      using errcode = '22023',
            hint    = 'meganet.inspection_config_section lists what each configuration prints';
  end if;

  return new;
end;
$$;

comment on function meganet.inspection_data_guard() is
  'The section guard for the initial and final data blocks, whose section is decided by the row''s own phase.';

drop trigger if exists inspection_data_section on meganet.inspection_data;
create trigger inspection_data_section before insert or update on meganet.inspection_data
  for each row execute function meganet.inspection_data_guard();

-- The ALERT IDs / accumulator values block inside both data sections. A list,
-- because a station has as many as it has sensors.
create table if not exists meganet.inspection_data_value (
  inspection_id  uuid    not null,
  phase          text    not null,
  ord            integer not null,
  alert_id       integer,
  label          text    not null default '',
  accumulator    numeric,
  value          numeric,
  primary key (inspection_id, phase, ord),
  foreign key (inspection_id, phase)
    references meganet.inspection_data (inspection_id, phase) on delete cascade
);

comment on table meganet.inspection_data_value is
  'The ALERT ID / accumulator value pairs inside a data block. No guard of its own — its foreign key reaches a row that has already been through one.';

-- Battery and the supply that charges it. One table for two sections: they are
-- one power story, they always print together, and splitting them would mean two
-- rows to write for every visit that has either.
create table if not exists meganet.inspection_power (
  inspection_id  uuid primary key references meganet.inspection (id) on delete cascade,
  power_key      text references meganet.power_supply (key),

  battery_existing_rating_ah      numeric,
  battery_existing_v              numeric,
  battery_existing_v_under_load   numeric,
  battery_existing_date_stamp     text not null default '',
  battery_replacement_rating_ah   numeric,
  battery_replacement_v           numeric,
  battery_replacement_v_under_load numeric,
  battery_replacement_date_stamp  text not null default '',
  -- Campbell and DataLogger - old print a minimum of 2.90 V against this one.
  lithium_battery_v               numeric,

  consumption_sleep_ma            numeric,
  consumption_interrogation_ma    numeric,
  consumption_operating_ma        numeric,
  -- Mace and DataLogger - old: the telephone line's own voltage.
  telephone_socket_v              numeric,

  solar_panel_rating_w      numeric,
  solar_output_v            numeric,
  solar_voltage_at_plug_v   numeric,
  solar_short_circuit_ma    numeric,
  solar_charge_current_ma   numeric,
  solar_under_load_ma       numeric,
  solar_trickle_charge_ma   numeric,
  solar_static_current_ma   numeric,
  solar_regulator_v         numeric,
  solar_step_up_v           numeric,
  -- Alert prints "Solar LED; on arrival / at depart", Campbell and the old
  -- logger print a charge LED. Free text: what people write here is a colour.
  led_on_arrival            text not null default '',
  led_at_departure          text not null default '',

  -- "Weather" — the conditions the solar readings were taken in, without which
  -- an output voltage means nothing.
  weather_note              text not null default '',
  mains_clean_undamaged     boolean,

  comments                  text not null default ''
);

comment on table meganet.inspection_power is
  'Sections 4 and 5 together — the battery and whatever charges it. The weather note is not decoration: a solar output voltage read under cloud is not comparable to one read in sun.';

drop trigger if exists inspection_power_section on meganet.inspection_power;
create trigger inspection_power_section before insert or update on meganet.inspection_power
  for each row execute function meganet.inspection_section_guard('battery');

-- The TBRG checks. The tip test itself is calibration rows; what is here is the
-- six yes/no checks, the reference values the test is read against, and the one
-- rule the sheet prints in words.
create table if not exists meganet.inspection_rain_gauge (
  inspection_id       uuid primary key references meganet.inspection (id) on delete cascade,
  instrument_type_key text references meganet.rain_instrument_type (key),

  gauge_level        boolean,
  drains_clear       boolean,
  syphon_cleaned     boolean,
  switch_ok          boolean,
  strainer_ok        boolean,
  buckets_adjusted   boolean,
  tip_test_ok        boolean,
  calibration_check  boolean,
  -- Printed in the header band of the Mace and DataLogger - old sheets rather
  -- than inside the Rain banner, but they are rain-gauge facts.
  syphon_fitted           boolean,
  levelling_checked       boolean,
  funnel_and_syphon_clean boolean,

  -- "ACCURACY CHECK METHOD". Campbell prints a chamber/nozzle table; Mace says a
  -- Rimco tool is required when water comes from a standard rain measure.
  accuracy_check_method  text not null default '',
  chamber_ml             numeric,
  nozzle_mm_per_hr       numeric,

  -- The expected values the tip test is compared against, which differ per gauge
  -- make and per sheet: Rimco 20.2mm/101 tips and HS 20.8mm/104 tips on Campbell
  -- and the old logger, HS 10.0mm / Rimco 10.4mm on Alert, 9.7mm on Mace.
  expected_rimco_mm    numeric,
  expected_rimco_tips  numeric,
  expected_hs_mm       numeric,
  expected_hs_tips     numeric,

  mean_pct_error   numeric,
  adjustment_made  boolean,
  -- "Calibration adjustment should only be performed if the mean % error after 3
  -- checks is greater than 6%." Printed on four of the six sheets, in words, next
  -- to a box nobody computes. It is a column with a default rather than a
  -- constant in code because a threshold that changes must not silently rewrite
  -- what past visits were judged against.
  adjustment_threshold_pct numeric not null default 6,
  adjustment_indicated boolean generated always as (
    mean_pct_error is not null and abs(mean_pct_error) > adjustment_threshold_pct) stored,

  comments text not null default ''
);

comment on table meganet.inspection_rain_gauge is
  'The Rain banner. adjustment_indicated is the sheet''s printed 6%% rule, computed instead of read.';
comment on column meganet.inspection_rain_gauge.adjustment_indicated is
  'True when the mean error across the three tip-test checks exceeds the threshold this visit was judged against. Generated — it cannot disagree with the numbers above it.';

drop trigger if exists inspection_rain_gauge_section on meganet.inspection_rain_gauge;
create trigger inspection_rain_gauge_section before insert or update on meganet.inspection_rain_gauge
  for each row execute function meganet.inspection_section_guard('rain_gauge');

-- River / water level. The Druck and shaft-encoder numbers are calibration rows;
-- what is here is the instrument, the staff gauge and the checks around them.
create table if not exists meganet.inspection_water_level (
  inspection_id       uuid primary key references meganet.inspection (id) on delete cascade,
  instrument_type_key text references meganet.wl_instrument_type (key),

  transmitter_type   text not null default '',
  transmitter_range  text not null default '',
  calibration_check  boolean,

  staff_gauge_in_good_condition boolean,
  staff_gauge_condition_key     text references meganet.condition_rating (key),
  staff_gauge_range             text not null default '',
  staff_gauge_survey_done       boolean,
  -- The Gas Only sheet's entire water-level content: one printed line reading
  -- "Staff Gauge:" with a space after it.
  staff_gauge_note              text not null default '',

  shaft_encoder_checked            boolean,
  -- "One full revolution = 36.5 increments" on the Campbell sheet. Recorded per
  -- visit rather than assumed, because it is a property of the encoder fitted.
  shaft_encoder_increments_per_rev numeric,

  current_wl_entered_for_ip_logger boolean,
  druck_dpi_calibration_check      boolean,

  -- Mace's River (Analogue) block.
  capillary_line_purged  boolean,
  dp_delay               text not null default '',
  dp_contacts_tested     boolean,
  dp_counter_cleaned     boolean,
  dp_counter_adjusted    boolean,

  comments text not null default ''
);

comment on table meganet.inspection_water_level is
  'The River banner, and the one line the Gas Only sheet prints in place of it.';

drop trigger if exists inspection_water_level_section on meganet.inspection_water_level;
create trigger inspection_water_level_section before insert or update on meganet.inspection_water_level
  for each row execute function meganet.inspection_section_guard('water_level');

-- The gas/bubbler system. Existing and replacement cylinder inline rather than as
-- two rows: there are exactly two, always, on every sheet that has this section.
create table if not exists meganet.inspection_gas (
  inspection_id uuid primary key references meganet.inspection (id) on delete cascade,

  existing_cylinder_pressure_kpa    numeric,
  existing_feed_pressure_kpa        numeric,
  existing_bubble_rate_bpm          numeric,
  replacement_cylinder_pressure_kpa numeric,
  replacement_feed_pressure_kpa     numeric,
  replacement_bubble_rate_bpm       numeric,
  spare_cylinder_at_station         boolean,

  compressor_pump_cycle_from_kpa numeric,
  compressor_pump_cycle_to_kpa   numeric,
  compressor_status_normal       boolean,
  compressor_fault_code          text not null default '',

  filter_desiccant_checked  boolean,
  filter_desiccant_replaced boolean,

  tested_for_leaks                boolean,
  leak_test_on_river_line_fitting boolean,
  orifice_checked                 boolean,
  bubble_unit_pressure_tested_m_h2o numeric,
  system_purged    boolean,
  gas_line_purged  boolean,

  consumption_kpa_per_month numeric,
  comments text not null default ''
);

comment on table meganet.inspection_gas is
  'The Gas banner. orifice_checked and gas_line_purged are the DataLogger - old sheet''s wording for checks the other sheets label differently; both are kept because a form from 2003 said one and a form from 2019 said the other.';

drop trigger if exists inspection_gas_section on meganet.inspection_gas;
create trigger inspection_gas_section before insert or update on meganet.inspection_gas
  for each row execute function meganet.inspection_section_guard('gas');

-- Radio and antenna. Alert prints the full block; Base Station prints the
-- antenna tests and nothing else, which is why the SWR columns are nullable
-- rather than the section being split in two.
create table if not exists meganet.inspection_radio (
  inspection_id uuid primary key references meganet.inspection (id) on delete cascade,

  tx_size_w numeric,

  existing_antenna        text not null default '',
  existing_frequency_mhz  numeric,
  existing_forward_w      numeric,
  existing_reflected_w    numeric,
  existing_swr            numeric,

  replacement_antenna       text not null default '',
  replacement_frequency_mhz numeric,
  replacement_forward_w     numeric,
  replacement_reflected_w   numeric,
  replacement_swr           numeric,

  -- The legend printed beside the SWR box on the Alert sheet: "<1.5 = Good
  -- 1.5 - 2.0 = Fair >2.0 = Poor". Generated rather than left to whoever reads
  -- the number later, and keyed to meganet.condition_rating so it says the same
  -- words the Council form's condition dropdown does.
  swr_rating text generated always as (
    case when existing_swr is null then null
         when existing_swr < 1.5   then 'good'
         when existing_swr <= 2.0  then 'fair'
         else 'poor' end) stored,

  comments text not null default ''
);

comment on table meganet.inspection_radio is
  'Antenna Tests. swr_rating applies the legend printed next to the box: under 1.5 good, 1.5-2.0 fair, over 2.0 poor.';

drop trigger if exists inspection_radio_section on meganet.inspection_radio;
create trigger inspection_radio_section before insert or update on meganet.inspection_radio
  for each row execute function meganet.inspection_section_guard('radio');

-- The fade margin table on the Alert sheet: TIME / LOAD (dB) / TIPS (TBRG) /
-- received at base, recorded once originally and again this visit.
create table if not exists meganet.inspection_fade_margin (
  inspection_id  uuid    not null references meganet.inspection (id) on delete cascade,
  -- The sheet's two column groups: ORIGINAL, and THIS VISIT.
  phase          text    not null check (phase in ('original', 'this_visit')),
  ord            integer not null,
  at_time        time,
  -- The reference scale printed on the sheet is Load 0-30 dB against Tips 1-11.
  load_db        numeric,
  tips           numeric,
  received_at_base boolean,
  comments       text not null default '',
  primary key (inspection_id, phase, ord)
);

comment on table meganet.inspection_fade_margin is
  'The Alert sheet''s PATH MARGIN (dB) table, as rows. Two passes: what it was (original) and what it is (this_visit).';

drop trigger if exists inspection_fade_margin_section on meganet.inspection_fade_margin;
create trigger inspection_fade_margin_section before insert or update on meganet.inspection_fade_margin
  for each row execute function meganet.inspection_section_guard('radio');

-- Decision 4. Every calibration block on every sheet, one shape.
create table if not exists meganet.inspection_calibration (
  inspection_id uuid    not null references meganet.inspection (id) on delete cascade,
  kind_key      text    not null references meganet.calibration_kind (key),
  -- Campbell and the old logger print an INITIAL and a FINAL grid; Alert and
  -- Mace print one. 'none' rather than null so it can sit in the primary key.
  phase         text    not null default 'none'
                        check (phase in ('none', 'initial', 'final')),
  -- The three tip-test checks, or receiver 1 and receiver 2.
  ord           integer not null default 1,

  label   text not null default '',
  method  text not null default '',
  units   text not null default '',

  expected_result numeric,
  start_value     numeric,
  end_value       numeric,
  result          numeric,
  measured        numeric,
  difference      numeric,
  pct_error       numeric,

  -- Kind-specific columns that earn their place because a sheet prints them as
  -- their own boxes: revolutions on the shaft encoder grid, an error in metres on
  -- the Druck grid, a frequency and a supply voltage on the receiver tests.
  revolutions   numeric,
  error_m       numeric,
  frequency_mhz numeric,
  supply_v      numeric,

  passed  boolean,
  notes   text not null default '',
  -- The long tail, so a kind with three boxes nobody else has does not become
  -- three columns everybody else carries null in. Currently the Enviromon line's
  -- div, b_offset and zero_adj. Not a dumping ground: anything a second kind
  -- also prints becomes a column.
  extra   jsonb not null default '{}'::jsonb,

  primary key (inspection_id, kind_key, phase, ord)
);

comment on table meganet.inspection_calibration is
  'Every calibration block on every sheet, in one shape: what was expected, where it started, where it ended, what came out, the difference, the error. #122 has 61 column layouts to flatten and this is the target.';
comment on column meganet.inspection_calibration.extra is
  'Kind-specific boxes no second kind prints. A field that turns up on a second sheet becomes a real column instead.';

-- This one's section comes from its kind, so the guard reads it off the row.
create or replace function meganet.inspection_calibration_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text;
  v_config  text;
begin
  select k.section_key into v_section
    from meganet.calibration_kind k where k.key = new.kind_key;
  if v_section is null then
    return new;   -- the foreign key is about to say it better
  end if;

  select i.config_key into v_config
    from meganet.inspection i where i.id = new.inspection_id;
  if v_config is null then
    return new;
  end if;

  if not exists (select 1 from meganet.inspection_config_section cs
                  where cs.config_key = v_config and cs.section_key = v_section) then
    raise exception
      'the % form has no % section, so a % calibration cannot belong to this inspection',
      v_config, v_section, new.kind_key
      using errcode = '22023',
            hint    = 'meganet.calibration_kind maps each kind to a section; '
                      'meganet.inspection_config_section says which sections each form prints';
  end if;

  return new;
end;
$$;

comment on function meganet.inspection_calibration_guard() is
  'The section guard for calibration rows, whose section is a property of the kind rather than of the table.';

drop trigger if exists inspection_calibration_section on meganet.inspection_calibration;
create trigger inspection_calibration_section
  before insert or update on meganet.inspection_calibration
  for each row execute function meganet.inspection_calibration_guard();

-- Data Quality. Two parameters, each rated twice.
create table if not exists meganet.inspection_data_quality (
  inspection_id     uuid not null references meganet.inspection (id) on delete cascade,
  parameter         text not null check (parameter in ('rain', 'water_level')),
  on_arrival_key    text references meganet.data_quality_rating (key),
  on_departure_key  text references meganet.data_quality_rating (key),
  comments          text not null default '',
  primary key (inspection_id, parameter)
);

comment on table meganet.inspection_data_quality is
  'The Data Quality block, on the Alert and Campbell sheets only. The departure rating is what meganet.inspection_needs_maintenance reads.';

drop trigger if exists inspection_data_quality_section on meganet.inspection_data_quality;
create trigger inspection_data_quality_section
  before insert or update on meganet.inspection_data_quality
  for each row execute function meganet.inspection_section_guard('data_quality');

-- The footer tick row.
create table if not exists meganet.inspection_admin (
  inspection_id   uuid primary key references meganet.inspection (id) on delete cascade,
  photos_taken    boolean,
  on_web          boolean,
  excel           boolean,
  wo_completed    boolean,
  meters_updated  boolean,
  eams_other      boolean,
  emon_op         boolean,
  drs             boolean,
  council_notified boolean,
  comments        text not null default ''
);

comment on table meganet.inspection_admin is
  'Photos / On Web? / Excel / WO Comp / Meters / EAMS other / E''mon OP / DRS / Council. The Base Station sheet prints the first, third, fourth, fifth and sixth only; the other four stay null there and the matrix says why.';

drop trigger if exists inspection_admin_section on meganet.inspection_admin;
create trigger inspection_admin_section before insert or update on meganet.inspection_admin
  for each row execute function meganet.inspection_section_guard('admin_checklist');

-- ── The maintenance activity ─────────────────────────────────────────────────
-- The Council Site Maintenance Tasks form. A different family: not a technical
-- calibration record but a stewardship and liaison one — who owns what, what
-- condition it is in, who to ring about it.
--
-- `inspection_id` is decision 5. Every inspection sheet ends by asking for one of
-- these when the site departs poor, and until now that was an instruction printed
-- on paper. Here it is a foreign key, and meganet.inspection_needs_maintenance
-- is the query that reads it.

create table if not exists meganet.maintenance_activity (
  id            uuid primary key default gen_random_uuid(),

  station_id    text references meganet.station (id),
  -- The visit that prompted this, when there was one. Null for a maintenance
  -- round that was not triggered by an inspection.
  inspection_id uuid references meganet.inspection (id) on delete set null,

  station_name  text not null default '',
  cbm_no        text not null default '',

  visited_on    date not null,
  recorded_by   text not null default '',

  council_key           text references meganet.council (key),
  council_contact_name  text not null default '',
  council_contact_email text not null default '',
  council_contact_phone text not null default '',
  council_comments      text not null default '',

  landowner_contact_name  text not null default '',
  landowner_contact_email text not null default '',
  landowner_contact_phone text not null default '',
  landowner_comments      text not null default '',

  -- Gauge Boards & Benchmark.
  gauge_boards_present    boolean,
  gauge_boards_condition_key text references meganet.condition_rating (key),
  gauge_boards_owner_key     text references meganet.asset_owner (key),
  -- The sheet prints "if yes take photo" against this one; the photo is an
  -- attachment with role 'gauge_board'.
  benchmark_present       boolean,
  benchmark_surveyed      boolean,
  gauge_boards_comments   text not null default '',

  -- "Assess and WHS": access and safety notes. On its own this is the single
  -- most sensitive free-text field in the schema, and the reason the whole
  -- maintenance family is editors-only.
  access_whs_comments text not null default '',

  remarks       text not null default '',
  -- Why this activity exists. 'poor_on_departure' when it came off an
  -- inspection's departure rating; free text otherwise.
  trigger_reason text not null default '',

  origin        text not null default 'form'
                     check (origin in ('form', 'import')),
  source_ref    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text,
  deleted_at    timestamptz
);

comment on table meganet.maintenance_activity is
  'The Council Site Maintenance Tasks form. Holds council and landowner contact details and site-access notes, which is why nothing here is readable with the anon key.';
comment on column meganet.maintenance_activity.inspection_id is
  'The visit that prompted this activity. This column is the printed instruction at the foot of every inspection sheet, made into a foreign key.';

create index if not exists maintenance_activity_station_idx on meganet.maintenance_activity
  (station_id, visited_on desc) where deleted_at is null;
create index if not exists maintenance_activity_inspection_idx on meganet.maintenance_activity
  (inspection_id) where inspection_id is not null and deleted_at is null;
create unique index if not exists maintenance_activity_source_ref_idx
  on meganet.maintenance_activity (source_ref) where source_ref is not null;

drop trigger if exists maintenance_activity_touch_updated_at on meganet.maintenance_activity;
create trigger maintenance_activity_touch_updated_at before update on meganet.maintenance_activity
  for each row execute function meganet.touch_updated_at();

-- The three parallel mini-panels: Rainfall, Water Level, Comms & Power. Same
-- three questions each — what is it, what condition, who owns it — plus three
-- more that only the comms panel asks. The check constraints below are the same
-- idea as the section guard one level down: a column that does not apply to a
-- panel must be null rather than quietly populated.
create table if not exists meganet.maintenance_asset (
  activity_id uuid not null references meganet.maintenance_activity (id) on delete cascade,
  asset       text not null check (asset in ('rainfall', 'water_level', 'comms_power')),

  rain_instrument_type_key text references meganet.rain_instrument_type (key),
  wl_instrument_type_key   text references meganet.wl_instrument_type (key),
  condition_key            text references meganet.condition_rating (key),
  owner_key                text references meganet.asset_owner (key),

  comms_method_key    text references meganet.comms_method (key),
  comms_equipment_key text references meganet.comms_equipment (key),
  power_key           text references meganet.power_supply (key),

  comments text not null default '',

  primary key (activity_id, asset),

  constraint maintenance_asset_instrument_matches_panel check (
    case asset
      when 'rainfall'    then wl_instrument_type_key is null
      when 'water_level' then rain_instrument_type_key is null
      else rain_instrument_type_key is null and wl_instrument_type_key is null
    end),
  constraint maintenance_asset_comms_only_on_comms_panel check (
    asset = 'comms_power'
    or (comms_method_key is null and comms_equipment_key is null and power_key is null))
);

comment on table meganet.maintenance_asset is
  'The three asset panels on the Council form. One row each; the checks keep a panel from carrying a field its panel does not print.';

create table if not exists meganet.maintenance_data_quality (
  activity_id      uuid not null references meganet.maintenance_activity (id) on delete cascade,
  parameter        text not null check (parameter in ('rainfall', 'river_level')),
  on_arrival_key   text references meganet.data_quality_rating (key),
  on_departure_key text references meganet.data_quality_rating (key),
  comments         text not null default '',
  primary key (activity_id, parameter)
);

comment on table meganet.maintenance_data_quality is
  'The Council form''s own data-quality block. Separate from the inspection''s because it is a separate form asked at a separate time, and its two parameters are named differently on the sheet.';

-- ── Attachments ──────────────────────────────────────────────────────────────
-- Both form families end in a photo checklist, and the one filled-in Council
-- sheet in the workbook answers its ALERT CANISTER CONFIGURATION panel with a
-- pasted screenshot of a terminal dump. That is the clearest signal in the
-- workbook that this domain needs attachments rather than more columns.
--
-- The bytes live in Supabase Storage; this table is the index. `storage_path`
-- is the object path within `storage_bucket`, and the unique constraint over the
-- pair is what stops the same object being claimed by two records.

create table if not exists meganet.attachment (
  id uuid primary key default gen_random_uuid(),

  inspection_id           uuid references meganet.inspection (id) on delete cascade,
  maintenance_activity_id uuid references meganet.maintenance_activity (id) on delete cascade,

  role_key     text    not null default 'photo' references meganet.attachment_role (key),
  ord          integer not null default 0,
  title        text    not null default '',
  caption      text    not null default '',

  storage_bucket text not null default 'inspections',
  storage_path   text not null,
  content_type   text not null default '',
  byte_size      bigint,
  taken_at       timestamptz,

  uploaded_by  text,
  created_at   timestamptz not null default now(),

  constraint attachment_belongs_to_exactly_one check (
    (inspection_id is not null)::integer
    + (maintenance_activity_id is not null)::integer = 1),
  constraint attachment_path_is_not_blank check (btrim(storage_path) <> '')
);

comment on table meganet.attachment is
  'Photos and pasted screenshots, for an inspection or for a maintenance activity — exactly one of the two. The bytes are in Supabase Storage; this is the index into it.';

create unique index if not exists attachment_object_idx on meganet.attachment
  (storage_bucket, storage_path);
create index if not exists attachment_inspection_idx on meganet.attachment
  (inspection_id, ord) where inspection_id is not null;
create index if not exists attachment_activity_idx on meganet.attachment
  (maintenance_activity_id, ord) where maintenance_activity_id is not null;

-- ── The form, for whoever is rendering it ────────────────────────────────────

create or replace view meganet.inspection_form
with (security_invoker = true) as
  select cs.config_key,
         c.label      as config_label,
         c.sheet      as config_sheet,
         cs.ord,
         cs.section_key,
         s.label      as section_label,
         s.home       as section_home,
         s.note       as section_note,
         cs.variant_note
    from meganet.inspection_config_section cs
    join meganet.inspection_config  c on c.key = cs.config_key
    join meganet.inspection_section s on s.key = cs.section_key;

comment on view meganet.inspection_form is
  'One row per section a configuration prints, in that configuration''s print order. What #116 renders from, and the answer to "does this form have a gas section".';

-- Decision 5, as a query. Every inspection whose departure rating is one the
-- ratings table marks as needing maintenance, with whether a maintenance
-- activity was ever raised against it.
create or replace view meganet.inspection_needs_maintenance
with (security_invoker = true) as
  select i.id            as inspection_id,
         i.station_id,
         i.station_name,
         i.cbm_no,
         i.config_key,
         i.inspected_on,
         q.parameter,
         q.on_departure_key,
         r.label         as on_departure_label,
         exists (select 1 from meganet.maintenance_activity m
                  where m.inspection_id = i.id and m.deleted_at is null)
                         as has_maintenance_activity
    from meganet.inspection i
    join meganet.inspection_data_quality q on q.inspection_id = i.id
    join meganet.data_quality_rating r on r.key = q.on_departure_key
   where i.deleted_at is null
     and r.needs_maintenance;

comment on view meganet.inspection_needs_maintenance is
  'The sentence printed at the foot of every inspection sheet — "sites on departure that are poor or have issues please complete Flood Warning Council Maintenance Project form" — as a list. has_maintenance_activity false is a site the instruction was printed for and nobody followed.';

-- ── Reading a whole record back ──────────────────────────────────────────────
-- One visit and everything hanging off it, as one document. Same reasoning as
-- meganet.stations_doc(): the app holds a record, not eleven joined result sets,
-- and a save that returns the saved document is what proves the write landed.

create or replace function meganet.inspection_doc(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.to_jsonb(i) - 'id'
      || pg_catalog.jsonb_build_object(
           'id', i.id,
           'serials', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) - 'inspection_id' order by s.ord)
                                  from meganet.inspection_serial s where s.inspection_id = i.id), '[]'::jsonb),
           'data', coalesce((select pg_catalog.jsonb_object_agg(d.phase,
                               pg_catalog.to_jsonb(d) - 'inspection_id' - 'section_key'
                               || pg_catalog.jsonb_build_object('values', coalesce((
                                    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) - 'inspection_id' - 'phase' order by v.ord)
                                      from meganet.inspection_data_value v
                                     where v.inspection_id = d.inspection_id and v.phase = d.phase), '[]'::jsonb)))
                               from meganet.inspection_data d where d.inspection_id = i.id), '{}'::jsonb),
           'power',       (select pg_catalog.to_jsonb(x) - 'inspection_id' from meganet.inspection_power x where x.inspection_id = i.id),
           'rain_gauge',  (select pg_catalog.to_jsonb(x) - 'inspection_id' from meganet.inspection_rain_gauge x where x.inspection_id = i.id),
           'water_level', (select pg_catalog.to_jsonb(x) - 'inspection_id' from meganet.inspection_water_level x where x.inspection_id = i.id),
           'gas',         (select pg_catalog.to_jsonb(x) - 'inspection_id' from meganet.inspection_gas x where x.inspection_id = i.id),
           'radio',       (select pg_catalog.to_jsonb(x) - 'inspection_id' from meganet.inspection_radio x where x.inspection_id = i.id),
           'admin',       (select pg_catalog.to_jsonb(x) - 'inspection_id' from meganet.inspection_admin x where x.inspection_id = i.id),
           'fade_margin', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(f) - 'inspection_id' order by f.phase, f.ord)
                                      from meganet.inspection_fade_margin f where f.inspection_id = i.id), '[]'::jsonb),
           'calibrations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(cb) - 'inspection_id' order by cb.kind_key, cb.phase, cb.ord)
                                      from meganet.inspection_calibration cb where cb.inspection_id = i.id), '[]'::jsonb),
           'data_quality', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(dq) - 'inspection_id' order by dq.parameter)
                                      from meganet.inspection_data_quality dq where dq.inspection_id = i.id), '[]'::jsonb),
           'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) - 'inspection_id' order by a.ord, a.created_at)
                                      from meganet.attachment a where a.inspection_id = i.id), '[]'::jsonb))
    from meganet.inspection i
   where i.id = p_id and i.deleted_at is null;
$$;

comment on function meganet.inspection_doc(uuid) is
  'One visit and every section hanging off it, as one JSON document. security invoker, so the row-level policies apply.';

create or replace function meganet.maintenance_activity_doc(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.to_jsonb(m)
      || pg_catalog.jsonb_build_object(
           'assets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) - 'activity_id' order by a.asset)
                                 from meganet.maintenance_asset a where a.activity_id = m.id), '[]'::jsonb),
           'data_quality', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) - 'activity_id' order by q.parameter)
                                 from meganet.maintenance_data_quality q where q.activity_id = m.id), '[]'::jsonb),
           'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) - 'maintenance_activity_id' order by t.ord, t.created_at)
                                 from meganet.attachment t where t.maintenance_activity_id = m.id), '[]'::jsonb))
    from meganet.maintenance_activity m
   where m.id = p_id and m.deleted_at is null;
$$;

comment on function meganet.maintenance_activity_doc(uuid) is
  'One Council Maintenance Tasks record, whole, as JSON.';

-- ── Writing ──────────────────────────────────────────────────────────────────
-- Same shape as 0004's station writes, and for the same reason: a record here is
-- a parent plus up to eleven children, and a visit whose gas section saved and
-- whose calibration rows did not is worse than one that did not save at all. No
-- table grants a write verb to a role a browser can reach; there are two doors
-- and they are functions.
--
-- One helper does the child writes. It takes a table name and a JSON object,
-- works out which of that table's columns the object actually mentions, skips the
-- generated ones, and inserts. That is what keeps the two save functions short
-- and — the reason it is worth the dynamic SQL — it means #116 adding a column to
-- a section table does not have to come back and edit a function to be able to
-- write it.

create or replace function meganet.form_write(p_table text, p_row jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cols text;
  v_sel  text;
begin
  -- The table list is closed. This function is only ever called from the two
  -- save functions below with a literal, and the guard is here so that stays
  -- true if somebody grants EXECUTE on it by accident.
  if p_table not in ('inspection_serial', 'inspection_data', 'inspection_data_value',
                     'inspection_power', 'inspection_rain_gauge', 'inspection_water_level',
                     'inspection_gas', 'inspection_radio', 'inspection_fade_margin',
                     'inspection_calibration', 'inspection_data_quality', 'inspection_admin',
                     'maintenance_asset', 'maintenance_data_quality', 'attachment') then
    raise exception 'meganet.form_write() does not write %', p_table using errcode = '22023';
  end if;

  if p_row is null or pg_catalog.jsonb_typeof(p_row) <> 'object' then
    raise exception 'meganet.form_write(%) needs a JSON object', p_table using errcode = '22023';
  end if;

  select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' order by a.attnum),
         pg_catalog.string_agg('r.' || pg_catalog.quote_ident(a.attname), ', ' order by a.attnum)
    into v_cols, v_sel
    from pg_catalog.pg_attribute a
   where a.attrelid = ('meganet.' || pg_catalog.quote_ident(p_table))::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attgenerated = ''          -- a generated column cannot be written to
     and p_row ? a.attname;

  if v_cols is null then
    return;   -- the object named nothing this table has; nothing to write
  end if;

  execute pg_catalog.format(
    'insert into meganet.%I (%s) select %s from pg_catalog.jsonb_populate_record(null::meganet.%I, $1) r',
    p_table, v_cols, v_sel, p_table) using p_row;
end;
$$;

comment on function meganet.form_write(text, jsonb) is
  'Insert one row into one section table from a JSON object, using only the columns the object mentions and never a generated one. Internal to the save functions; not granted to anything a browser can reach.';

-- Save one visit, whole.
--
-- Takes the document meganet.inspection_doc() returns, so the app round-trips one
-- shape. Children are replaced rather than merged: the form holds the whole
-- record on screen, and a merge would make "I deleted that serial number row"
-- unexpressible.
--
-- p_expected_updated_at is the stamp the form loaded the visit with. Required for
-- an existing record, must be null for a new one, and a mismatch is refused with
-- PT409 — HTTP 409 — rather than merged. Exactly 0004's contract.
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
      inspected_on, inspector, office_last_visit, office_stock_changes,
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

create or replace function meganet.save_maintenance_activity(
         p_doc jsonb,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid := nullif(p_doc ->> 'id', '')::uuid;
  v_actor  text := meganet.actor();
  v_is_new boolean;
  v_prev   timestamptz;
  v_item   jsonb;
  v_key    jsonb;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write maintenance activities'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  if nullif(p_doc ->> 'visited_on', '') is null then
    raise exception 'a maintenance activity needs the date it was carried out'
      using errcode = '22023';
  end if;

  if v_id is null then
    v_is_new := true;
    v_id := pg_catalog.gen_random_uuid();
    if p_expected_updated_at is not null then
      raise exception 'a new maintenance activity cannot have been changed by anyone else'
        using errcode = 'PT409';
    end if;
  else
    select updated_at into v_prev from meganet.maintenance_activity where id = v_id for update;
    v_is_new := not found;
    if v_is_new and p_expected_updated_at is not null then
      raise exception 'maintenance activity % is no longer in the database — it was deleted while you had it open', v_id
        using errcode = 'PT409';
    end if;
    if not v_is_new then
      if p_expected_updated_at is null then
        raise exception 'this form did not load maintenance activity % from the database, so it will not overwrite it', v_id
          using errcode = 'PT409';
      end if;
      if v_prev is distinct from p_expected_updated_at then
        raise exception 'maintenance activity % was changed in the database at %, after you opened it', v_id, v_prev
          using errcode = 'PT409',
                hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
      end if;
    end if;
  end if;

  insert into meganet.maintenance_activity (
      id, station_id, inspection_id, station_name, cbm_no, visited_on, recorded_by,
      council_key, council_contact_name, council_contact_email, council_contact_phone,
      council_comments, landowner_contact_name, landowner_contact_email,
      landowner_contact_phone, landowner_comments,
      gauge_boards_present, gauge_boards_condition_key, gauge_boards_owner_key,
      benchmark_present, benchmark_surveyed, gauge_boards_comments,
      access_whs_comments, remarks, trigger_reason, origin, source_ref, updated_by)
  values (
      v_id,
      nullif(p_doc ->> 'station_id', ''),
      (nullif(p_doc ->> 'inspection_id', ''))::uuid,
      coalesce(p_doc ->> 'station_name', ''),
      coalesce(p_doc ->> 'cbm_no', ''),
      (p_doc ->> 'visited_on')::date,
      coalesce(p_doc ->> 'recorded_by', ''),
      nullif(p_doc ->> 'council_key', ''),
      coalesce(p_doc ->> 'council_contact_name', ''),
      coalesce(p_doc ->> 'council_contact_email', ''),
      coalesce(p_doc ->> 'council_contact_phone', ''),
      coalesce(p_doc ->> 'council_comments', ''),
      coalesce(p_doc ->> 'landowner_contact_name', ''),
      coalesce(p_doc ->> 'landowner_contact_email', ''),
      coalesce(p_doc ->> 'landowner_contact_phone', ''),
      coalesce(p_doc ->> 'landowner_comments', ''),
      (nullif(p_doc ->> 'gauge_boards_present', ''))::boolean,
      nullif(p_doc ->> 'gauge_boards_condition_key', ''),
      nullif(p_doc ->> 'gauge_boards_owner_key', ''),
      (nullif(p_doc ->> 'benchmark_present', ''))::boolean,
      (nullif(p_doc ->> 'benchmark_surveyed', ''))::boolean,
      coalesce(p_doc ->> 'gauge_boards_comments', ''),
      coalesce(p_doc ->> 'access_whs_comments', ''),
      coalesce(p_doc ->> 'remarks', ''),
      coalesce(p_doc ->> 'trigger_reason', ''),
      coalesce(nullif(p_doc ->> 'origin', ''), 'form'),
      nullif(p_doc ->> 'source_ref', ''),
      v_actor)
  on conflict (id) do update set
      station_id = excluded.station_id,
      inspection_id = excluded.inspection_id,
      station_name = excluded.station_name,
      cbm_no = excluded.cbm_no,
      visited_on = excluded.visited_on,
      recorded_by = excluded.recorded_by,
      council_key = excluded.council_key,
      council_contact_name = excluded.council_contact_name,
      council_contact_email = excluded.council_contact_email,
      council_contact_phone = excluded.council_contact_phone,
      council_comments = excluded.council_comments,
      landowner_contact_name = excluded.landowner_contact_name,
      landowner_contact_email = excluded.landowner_contact_email,
      landowner_contact_phone = excluded.landowner_contact_phone,
      landowner_comments = excluded.landowner_comments,
      gauge_boards_present = excluded.gauge_boards_present,
      gauge_boards_condition_key = excluded.gauge_boards_condition_key,
      gauge_boards_owner_key = excluded.gauge_boards_owner_key,
      benchmark_present = excluded.benchmark_present,
      benchmark_surveyed = excluded.benchmark_surveyed,
      gauge_boards_comments = excluded.gauge_boards_comments,
      access_whs_comments = excluded.access_whs_comments,
      remarks = excluded.remarks,
      trigger_reason = excluded.trigger_reason,
      origin = excluded.origin,
      source_ref = excluded.source_ref,
      deleted_at = null,
      updated_by = excluded.updated_by;

  delete from meganet.maintenance_asset        where activity_id = v_id;
  delete from meganet.maintenance_data_quality where activity_id = v_id;

  v_key := pg_catalog.jsonb_build_object('activity_id', v_id);

  for v_item in
    select value from pg_catalog.jsonb_array_elements(coalesce(nullif(p_doc -> 'assets', 'null'::jsonb), '[]'::jsonb))
  loop
    perform meganet.form_write('maintenance_asset', v_item || v_key);
  end loop;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(coalesce(nullif(p_doc -> 'data_quality', 'null'::jsonb), '[]'::jsonb))
  loop
    perform meganet.form_write('maintenance_data_quality', v_item || v_key);
  end loop;

  return meganet.maintenance_activity_doc(v_id);
end;
$$;

comment on function meganet.save_maintenance_activity(jsonb, timestamptz) is
  'Insert or update one Council Maintenance Tasks record and its panels, in one transaction. Same stale-write contract as meganet.save_station().';

-- Soft delete, both families. Same as 0004: the row and everything under it stay,
-- and the reads filter on deleted_at. Undone with one update.
create or replace function meganet.delete_inspection(
         p_id uuid,
         p_expected_updated_at timestamptz default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev timestamptz;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to delete inspections' using errcode = '42501';
  end if;

  select updated_at into v_prev from meganet.inspection
   where id = p_id and deleted_at is null for update;
  if not found then
    return false;
  end if;
  if p_expected_updated_at is not null and v_prev is distinct from p_expected_updated_at then
    raise exception 'inspection % was changed in the database at %, after you opened it', p_id, v_prev
      using errcode = 'PT409';
  end if;

  update meganet.inspection
     set deleted_at = pg_catalog.now(), updated_by = meganet.actor()
   where id = p_id;
  return true;
end;
$$;

comment on function meganet.delete_inspection(uuid, timestamptz) is
  'Soft delete: stamps deleted_at, keeps every row. Undone with `update meganet.inspection set deleted_at = null where id = ...`.';

create or replace function meganet.delete_maintenance_activity(
         p_id uuid,
         p_expected_updated_at timestamptz default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev timestamptz;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to delete maintenance activities' using errcode = '42501';
  end if;

  select updated_at into v_prev from meganet.maintenance_activity
   where id = p_id and deleted_at is null for update;
  if not found then
    return false;
  end if;
  if p_expected_updated_at is not null and v_prev is distinct from p_expected_updated_at then
    raise exception 'maintenance activity % was changed in the database at %, after you opened it', p_id, v_prev
      using errcode = 'PT409';
  end if;

  update meganet.maintenance_activity
     set deleted_at = pg_catalog.now(), updated_by = meganet.actor()
   where id = p_id;
  return true;
end;
$$;

comment on function meganet.delete_maintenance_activity(uuid, timestamptz) is
  'Soft delete for a Council Maintenance Tasks record.';

-- ── Row level security ───────────────────────────────────────────────────────
-- Every table this file creates, per db/README.md. Supabase's rls_auto_enable
-- event trigger only covers `public`; ours is `meganet` and nothing catches this
-- for us.
--
-- Two groups, and the split is the security decision stated at the top of the
-- file.
--
-- **The vocabularies are public.** The eleven lookup tables and the three form
-- tables are the words on a printed form. #116 needs them to render its pick
-- lists, some of that rendering happens before anyone signs in, and none of it
-- says anything about a site.
--
-- **The records are not.** An inspection's remarks carry site access notes, and
-- the Council form carries landowner names, emails and phone numbers. The anon
-- key is committed to this repo and served from GitHub Pages, so "readable by
-- anon" here would mean "published". Editors only — which is who fills these
-- forms in, and who #118's history view is for.

do $$
declare
  t text;
begin
  foreach t in array array[
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
      'attachment'] loop
    execute pg_catalog.format('alter table meganet.%I enable row level security', t);
  end loop;
end
$$;

-- The public half.
do $$
declare
  t text;
begin
  foreach t in array array[
      'rain_instrument_type', 'condition_rating', 'asset_owner', 'wl_instrument_type',
      'comms_method', 'comms_equipment', 'power_supply', 'yes_no', 'data_quality_rating',
      'council', 'equipment_kind', 'attachment_role',
      'inspection_config', 'inspection_section', 'inspection_config_section',
      'calibration_kind'] loop
    execute pg_catalog.format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for select using (true)', t || '_read_all', t);
  end loop;
end
$$;

-- The records. Read and write, editors only. The save functions are
-- `security definer` and run past these; the policies are what stands between a
-- future `grant select … to anon` and a published landowner phone number.
do $$
declare
  t text;
  v text;
begin
  foreach t in array array[
      'inspection', 'inspection_serial', 'inspection_data', 'inspection_data_value',
      'inspection_power', 'inspection_rain_gauge', 'inspection_water_level',
      'inspection_gas', 'inspection_radio', 'inspection_fade_margin',
      'inspection_calibration', 'inspection_data_quality', 'inspection_admin',
      'maintenance_activity', 'maintenance_asset', 'maintenance_data_quality',
      'attachment'] loop
    execute pg_catalog.format('drop policy if exists %I on meganet.%I', t || '_read_editors', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for select to authenticated
         using (meganet.is_editor())', t || '_read_editors', t);
    foreach v in array array['insert', 'update', 'delete'] loop
      execute pg_catalog.format('drop policy if exists %I on meganet.%I', t || '_' || v || '_editors', t);
    end loop;
    execute pg_catalog.format(
      'create policy %I on meganet.%I for insert to authenticated
         with check (meganet.is_editor())', t || '_insert_editors', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for update to authenticated
         using (meganet.is_editor()) with check (meganet.is_editor())',
      t || '_update_editors', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for delete to authenticated
         using (meganet.is_editor())', t || '_delete_editors', t);
  end loop;
end
$$;

-- ── Who may run what ─────────────────────────────────────────────────────────
-- Postgres hands EXECUTE on every new function to PUBLIC, and five of these
-- write, so the default is revoked explicitly — see db/README.md.
--
-- meganet.form_write() is the one to look at twice. It builds an INSERT with
-- dynamic SQL, and although its table list is closed and every identifier goes
-- through quote_ident, it is granted to nothing: the two save functions are
-- `security definer` and reach it as this file's owner, and no role a browser
-- can reach holds EXECUTE on it.
revoke all on function meganet.form_write(text, jsonb)                        from public;
revoke all on function meganet.save_inspection(jsonb, timestamptz)            from public;
revoke all on function meganet.save_maintenance_activity(jsonb, timestamptz)  from public;
revoke all on function meganet.delete_inspection(uuid, timestamptz)           from public;
revoke all on function meganet.delete_maintenance_activity(uuid, timestamptz) from public;
revoke all on function meganet.inspection_doc(uuid)                           from public;
revoke all on function meganet.maintenance_activity_doc(uuid)                 from public;
revoke all on function meganet.inspection_section_guard()                     from public;
revoke all on function meganet.inspection_data_guard()                        from public;
revoke all on function meganet.inspection_calibration_guard()                 from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on
      meganet.rain_instrument_type, meganet.condition_rating, meganet.asset_owner,
      meganet.wl_instrument_type, meganet.comms_method, meganet.comms_equipment,
      meganet.power_supply, meganet.yes_no, meganet.data_quality_rating,
      meganet.council, meganet.equipment_kind, meganet.attachment_role,
      meganet.inspection_config, meganet.inspection_section,
      meganet.inspection_config_section, meganet.calibration_kind,
      meganet.inspection_form
    to anon, authenticated;

  grant select on
      meganet.inspection, meganet.inspection_serial, meganet.inspection_data,
      meganet.inspection_data_value, meganet.inspection_power,
      meganet.inspection_rain_gauge, meganet.inspection_water_level,
      meganet.inspection_gas, meganet.inspection_radio,
      meganet.inspection_fade_margin, meganet.inspection_calibration,
      meganet.inspection_data_quality, meganet.inspection_admin,
      meganet.maintenance_activity, meganet.maintenance_asset,
      meganet.maintenance_data_quality, meganet.attachment,
      meganet.inspection_needs_maintenance
    to authenticated;

  grant select, insert, update, delete on
      meganet.rain_instrument_type, meganet.condition_rating, meganet.asset_owner,
      meganet.wl_instrument_type, meganet.comms_method, meganet.comms_equipment,
      meganet.power_supply, meganet.yes_no, meganet.data_quality_rating,
      meganet.council, meganet.equipment_kind, meganet.attachment_role,
      meganet.inspection_config, meganet.inspection_section,
      meganet.inspection_config_section, meganet.calibration_kind,
      meganet.inspection, meganet.inspection_serial, meganet.inspection_data,
      meganet.inspection_data_value, meganet.inspection_power,
      meganet.inspection_rain_gauge, meganet.inspection_water_level,
      meganet.inspection_gas, meganet.inspection_radio,
      meganet.inspection_fade_margin, meganet.inspection_calibration,
      meganet.inspection_data_quality, meganet.inspection_admin,
      meganet.maintenance_activity, meganet.maintenance_asset,
      meganet.maintenance_data_quality, meganet.attachment
    to service_role;

  grant execute on function meganet.save_inspection(jsonb, timestamptz)            to authenticated, service_role;
  grant execute on function meganet.save_maintenance_activity(jsonb, timestamptz)  to authenticated, service_role;
  grant execute on function meganet.delete_inspection(uuid, timestamptz)           to authenticated, service_role;
  grant execute on function meganet.delete_maintenance_activity(uuid, timestamptz) to authenticated, service_role;
  grant execute on function meganet.inspection_doc(uuid)                           to authenticated, service_role;
  grant execute on function meganet.maintenance_activity_doc(uuid)                 to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '9')
on conflict (key) do update set value = excluded.value;
