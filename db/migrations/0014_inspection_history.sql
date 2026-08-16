-- 0014_inspection_history.sql — #126 (H4). The historical inspection record,
-- in the same schema as the current one.
--
-- #124 extracted 14,982 inspections, 1,093 station blocks, 151,532 measured
-- cells and 153 rejects out of `archive/QLD All Site Inspections.xlsx`. #125
-- decided which MegaNet station each block is. This migration is where those
-- land, and it is the file that has to answer #126's question: what does a
-- schema designed around the *current* paper form do with 35 years of rows that
-- were recorded on a different one?
--
-- Two answers were available and both are wrong, which is why this file is long.
-- A parallel set of `historical_*` tables would mean #118's history view queries
-- two places and #78's work benefits from none of this. Flattening the history
-- into the current form would mean dropping `telephone socket voltage` because
-- the modern ALERT sheet has no such box, and coercing a fade margin of `>30`
-- to `30` — inventing a precision the technician explicitly did not record.
--
-- What this file does instead, in one sentence: **the historical rows go into
-- 0009's own tables, and every cell keeps its source string in a companion row
-- beside the number.** Five things follow, and each one is a section below.
--
--   1. Where the workbook records something the paper form never printed, the
--      column is added to 0009's table (§1) — not to a table of its own.
--   2. Where the workbook records a *section* that the configuration's current
--      form no longer prints, the matrix says so rather than the loader
--      dropping it (§3). Two of those exist and they are named.
--   3. Every measured cell is stored twice over: once as the number, in the
--      section column a form submission would use, and once in
--      `meganet.inspection_measurement` as the string the spreadsheet actually
--      held (§7). The first is what a chart reads; the second is what an
--      auditor reads, and it is the one that is authoritative.
--   4. A value that is a bound (`>30`), a status (`-`, `U/S`) or a sentence
--      ("Unable to access battery box") has **no** number. The measurement row
--      carries the operator and the bound, or the status code, or the prose;
--      the section column stays null. See docs/inspection-workbook-parse-spec.md
--      §5 — the rule is #122's acceptance and it is absolute.
--   5. The workbook's own structure — the sheet, the station block, the row —
--      is recorded (§5), so any number in the database can be traced back to
--      the cell it was read out of.
--
-- Applying this file creates the shape. Filling it is `tools/ingest/load.py`,
-- and `tools/check_inspection_history.sql` proves both.

-- ─────────────────────────────────────────────────────────────────────────────
-- §1. Four boxes the paper form does not print, and one the workbook does
-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 read its columns off `Inspection_sheets_for_printing.xlsx`, which is the
-- *blank* form as it stands today. The historical workbook prints boxes that
-- form has since dropped. `consumption_standby_ma` alone appears on 10,942
-- inspection rows — it is not an edge case, it is one of the ten commonest
-- readings in the entire archive, and #115 has no column for it only because
-- the 2024 sheet stopped asking.
--
-- These are columns on 0009's tables, not a side table. A standby current is a
-- power reading; where it is stored should not depend on which decade it was
-- taken in.

alter table meganet.inspection_power
  add column if not exists consumption_standby_ma  numeric,
  add column if not exists consumption_transmit_ma numeric,
  add column if not exists mains_charge_current_ma numeric,
  add column if not exists mains_regulated_v       numeric;

comment on column meganet.inspection_power.consumption_standby_ma is
  'Standby draw. On 10,942 historical ALERT rows and on no current sheet — 0009 has sleep, operating and interrogation because that is what the 2024 form asks.';
comment on column meganet.inspection_power.consumption_transmit_ma is
  'Draw while transmitting. 609 historical rows.';
comment on column meganet.inspection_power.mains_charge_current_ma is
  'Mains charger, on the layouts that have one instead of solar.';
comment on column meganet.inspection_power.mains_regulated_v is
  'Regulated voltage out of the mains charger.';

alter table meganet.inspection_radio
  add column if not exists tx_deviation_khz numeric;

comment on column meganet.inspection_radio.tx_deviation_khz is
  'Transmitter deviation. 28 historical rows; no current sheet prints it.';

-- ─────────────────────────────────────────────────────────────────────────────
-- §2. The eighth calibration kind
-- ─────────────────────────────────────────────────────────────────────────────
-- 0009's comment on meganet.calibration_kind predicted this: "#122 will meet
-- layouts this list has not seen." It met one. 28,837 of the archive's readings
-- are river-calibration points — a station is pumped to a known height and the
-- reading is written under a numeric column header — and none of the seven
-- kinds is that.
--
-- The parse spec (§4) is explicit that the points are per *block*, not per
-- sheet: 37 distinct point sets, and a point row dropped between two data rows
-- redefines the scale for everything below it. That is why the point is stored
-- on the row (`expected_result`) rather than implied by `ord`: the third column
-- is 15 metres on one block and 0.25 on another, and treating `ord` as the
-- point would silently rescale a station's calibration history.

insert into meganet.calibration_kind (key, ord, label, section_key, note) values
  ('river_calibration', 8, 'River calibration', 'water_level',
   'The variable calibration grid on the historical sheets: expected_result is the point (the header label, in the block''s own units) and result is the reading at it. Points are per block and a point row inside the data redefines them — see docs/inspection-workbook-parse-spec.md §4.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label,
                                section_key = excluded.section_key, note = excluded.note;

-- ─────────────────────────────────────────────────────────────────────────────
-- §3. A section a form used to print
-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 made "this form does not have that section" structural: a row absent
-- from meganet.inspection_config_section means the section is not on the form,
-- and every section table carries a trigger refusing a row for a section its
-- configuration does not print. That was the right call and this file keeps it.
--
-- The archive breaks it in exactly two places, both measured, both small, and
-- neither an extraction error:
--
--   * 233 readings on ALERT blocks are decoder and receiver tests. The current
--     ALERT sheet has no `base_tests` section — those moved to the Base Station
--     sheet — but ALERT-sheet repeater sites were recorded with them for years.
--   * 31 readings on DATA LOGGER blocks are transmitter power, SWR and fade
--     margin. 0009 records, correctly and against the workbook's own Index
--     sheet, that the current DataLogger - old form prints no radio section.
--
-- Dropping 264 real measurements to protect a constraint would be the second
-- failure mode #126 exists to avoid. Widening the matrix silently would put a
-- radio section back on #116's DataLogger form, which is a different and worse
-- error. So the matrix grows a column instead: `printed` is what the form
-- prints *now*, and a row with `printed = false` says this configuration has
-- carried this section historically and does not any more.
--
-- #116 reads meganet.inspection_form, which filters on it. The guards do not:
-- they allow a retired section on an imported row and go on refusing it on a
-- form submission, which is exactly the distinction.

alter table meganet.inspection_config_section
  add column if not exists printed boolean not null default true;

comment on column meganet.inspection_config_section.printed is
  'True when the current sheet prints this section. False when the configuration carried it historically and the form has since dropped it — the row still exists so that an imported inspection may hold one, while a form submission may not.';

insert into meganet.inspection_config_section (config_key, section_key, ord, variant_note, printed) values
  ('alert', 'base_tests', 90,
   'Retired. 233 readings on historical ALERT blocks are decoder and receiver tests, from the years when repeater sites were written up on the ALERT sheet. The current sheet prints these on Base Station only.', false),
  ('datalogger_old', 'radio', 91,
   'Retired. 31 readings on historical DATA LOGGER blocks are transmitter power, SWR and fade margin. The current DataLogger - old sheet prints no radio section, which 0009 recorded off the sheets themselves.', false)
on conflict (config_key, section_key) do update
  set ord = excluded.ord, variant_note = excluded.variant_note, printed = excluded.printed;

-- meganet.inspection_form is what a form renderer asks, so it answers about the
-- form as it is printed today. Recreated rather than altered because a view's
-- column list is fixed once created.
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
    join meganet.inspection_section s on s.key = cs.section_key
   where cs.printed;

comment on view meganet.inspection_form is
  'One row per section a configuration prints *today*, in its own print order. What #116 renders from. Retired sections (printed = false) are deliberately absent: they are history, not a form.';

-- The three guards, restated. The only change is the last condition of each:
-- a retired section is allowed on an imported row and refused on a typed one.

create or replace function meganet.inspection_section_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text := nullif(tg_argv[0], '');
  v_config  text;
  v_origin  text;
begin
  if v_section is null then
    raise exception 'trigger % on % was given no section to check', tg_name, tg_table_name
      using errcode = '22023';
  end if;

  select i.config_key, i.origin into v_config, v_origin
    from meganet.inspection i
   where i.id = (pg_catalog.to_jsonb(new) ->> 'inspection_id')::uuid;

  if v_config is null then
    -- The foreign key will say this better than we can.
    return new;
  end if;

  if not exists (select 1 from meganet.inspection_config_section cs
                  where cs.config_key = v_config and cs.section_key = v_section
                    and (cs.printed or v_origin = 'import')) then
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
  'Refuses a section row for a configuation whose form does not print that section. A section marked printed = false is history: an imported row may carry it, a form submission may not.';

create or replace function meganet.inspection_data_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text := new.phase || '_data';
  v_config  text;
  v_origin  text;
begin
  select i.config_key, i.origin into v_config, v_origin
    from meganet.inspection i where i.id = new.inspection_id;
  if v_config is null then
    return new;   -- the foreign key is about to say it better
  end if;

  if not exists (select 1 from meganet.inspection_config_section cs
                  where cs.config_key = v_config and cs.section_key = v_section
                    and (cs.printed or v_origin = 'import')) then
    raise exception 'the % form has no % section, so this inspection cannot carry one',
      v_config, v_section
      using errcode = '22023',
            hint    = 'meganet.inspection_config_section lists what each configuration prints';
  end if;

  return new;
end;
$$;

create or replace function meganet.inspection_calibration_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section text;
  v_config  text;
  v_origin  text;
begin
  select k.section_key into v_section
    from meganet.calibration_kind k where k.key = new.kind_key;
  if v_section is null then
    return new;   -- the foreign key is about to say it better
  end if;

  select i.config_key, i.origin into v_config, v_origin
    from meganet.inspection i where i.id = new.inspection_id;
  if v_config is null then
    return new;
  end if;

  if not exists (select 1 from meganet.inspection_config_section cs
                  where cs.config_key = v_config and cs.section_key = v_section
                    and (cs.printed or v_origin = 'import')) then
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

-- ─────────────────────────────────────────────────────────────────────────────
-- §4. What an imported visit knows about itself
-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 already left two of these here: `origin`, so an imported row is never
-- mistaken for one somebody typed, and `source_ref`, unique, so a re-run of the
-- extractor updates rather than duplicates. What it could not leave was the
-- shape of the provenance, because #124 had not decided it yet. It has now:
-- a ref is `<workbook>:<sheet>:<banner row>:<row>`, and the four parts are
-- worth having as columns because "show me everything off the Fitzroy sheet" is
-- a question somebody will ask.
--
-- The date precision is the other thing that could not be deferred. Nine rows
-- in the archive say only `1990`, beside a remark like "Station installed." —
-- they are events, not dated inspections, and a history view that prints them
-- as "1 January 1990" is asserting something the workbook never said.

alter table meganet.inspection
  add column if not exists date_precision   text    not null default 'day'
                                            check (date_precision in ('day', 'month', 'year')),
  add column if not exists date_raw         text    not null default '',
  add column if not exists source_workbook  text    not null default '',
  add column if not exists source_sheet     text    not null default '',
  add column if not exists source_block_ref text,
  add column if not exists source_row       integer,
  add column if not exists station_match    text    not null default 'form'
                                            check (station_match in
                                              ('form', 'number', 'name',
                                               'number_ambiguous', 'name_ambiguous',
                                               'unmatched')),
  add column if not exists station_key      text,
  -- Threaded cell comments, the raw station-number cell where it disagreed with
  -- the banner, and any flag the parser raised on the row. Small, irregular, and
  -- none of it a measurement — but #122 counted the comments as a reason this
  -- archive is worth having, so they do not get dropped on the way in.
  add column if not exists source_notes     jsonb   not null default '{}'::jsonb;

comment on column meganet.inspection.date_precision is
  'How much of inspected_on the workbook actually said. `year` means the cell held only a year and the month and day are this schema''s invention, not the record''s — #128 must not print one as a date.';
comment on column meganet.inspection.date_raw is
  'The date cell as it stood: an Excel datetime, `16/03/06`, or `1990`. Kept because 974 of these rows were parsed from text under a day/month/year rule, and the rule should be checkable against the cell.';
comment on column meganet.inspection.source_sheet is
  'The worksheet this row was read from. `source_block_ref` and `source_row` finish the address; together they are the cell somebody doubting a number should open.';
comment on column meganet.inspection.station_match is
  '#125''s verdict on who this station is. `number` matched a CBM/Bureau number, `name` matched a name, `*_ambiguous` found more than one candidate, `unmatched` found none — and in the last three station_id is null and the row is parked, not lost. `form` is a row somebody typed, where the question never arose.';
comment on column meganet.inspection.station_key is
  '#125''s crosswalk key for this row''s block, so that accepting a proposed match later is an update against this column rather than a reload.';
comment on column meganet.inspection.source_notes is
  'What the parser recorded about the row that is not a measurement: threaded cell comments (36 of them, invisible to anyone not in Excel), a station-number cell disagreeing with the banner, an Excel error in the station name.';

create index if not exists inspection_source_sheet_idx on meganet.inspection
  (source_sheet, source_row) where origin = 'import';
-- The backfill in §10 drives off this one: parked rows, by crosswalk key.
create index if not exists inspection_station_key_idx on meganet.inspection
  (station_key) where station_id is null and station_key is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- §5. The workbook's own structure, as rows
-- ─────────────────────────────────────────────────────────────────────────────
-- A basin sheet is dozens of independent mini-sheets glued vertically, and the
-- unit is the **block**: a banner naming a station, an `ID's` line, a stacked
-- column header, then that station's visits until the next banner. The block is
-- also the grain at which several facts are true — a property owner, the ALERT
-- addresses the site transmits on, the surveyed level of its gas orifice — and
-- those facts are not per-visit. They belong here.
--
-- This table is also the answer to "which columns was this row read under",
-- which is the only way to check a suspicious value without reopening a 7 MB
-- spreadsheet: `columns` is the resolved header the block's rows were parsed
-- with, and `notes` is what the parser had to decide.

create table if not exists meganet.inspection_block (
  ref            text    primary key,
  source         text    not null default '',
  sheet          text    not null default '',
  banner_row     integer,
  end_row        integer,
  block_index    integer,

  -- The banner's own words: `ALERT INSPECTION SUMMARY`, `DATA LOGGER …`.
  family         text    not null default '',
  config_key     text    references meganet.inspection_config (key),

  station_name   text    not null default '',
  cbm_no         text    not null default '',
  station_id     text    references meganet.station (id),
  station_key    text,
  station_match  text    not null default 'unmatched'
                         check (station_match in
                           ('number', 'name', 'number_ambiguous', 'name_ambiguous', 'unmatched')),

  -- The line above the banner, where a sheet has one.
  property_owner text    not null default '',

  -- The `ID's` line as it was written, before it was split into facts below.
  ids_raw        text    not null default '',

  -- Which rows the stacked header occupied, and where the date lives.
  header_rows    integer[] not null default '{}',
  date_column    text    not null default '',
  inherited_header boolean not null default false,

  -- The resolved header: column letter → {label, field}. What the block's rows
  -- were read under, kept so a value can be checked without the workbook.
  columns        jsonb   not null default '{}'::jsonb,
  -- Column letter → calibration point, for the blocks that have a grid.
  calibration_points jsonb not null default '{}'::jsonb,
  -- What the parser had to decide: an absorbed header value, a stray point row
  -- above the header, a repeater window, a CBM read off a note.
  notes          jsonb   not null default '{}'::jsonb,
  -- Threaded cell comments and loose annotations found inside the block.
  annotations    jsonb   not null default '[]'::jsonb,
  comments       jsonb   not null default '[]'::jsonb,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table meganet.inspection_block is
  'One station block on one worksheet — the unit the historical workbook is actually made of. Every imported inspection points at the block it was read out of, and the block carries what the parser resolved: the header, the calibration points, and the decisions it had to make.';
comment on column meganet.inspection_block.columns is
  'The resolved stacked header, column letter → {label, field}. 61 distinct layouts across the workbook; this is the one this block''s rows were read under.';
comment on column meganet.inspection_block.station_match is
  'How #125 attributed this block. Unmatched blocks keep station_name and cbm_no and are backfilled by meganet.backfill_inspection_station(), not reloaded.';

create index if not exists inspection_block_sheet_idx on meganet.inspection_block (sheet, banner_row);
create index if not exists inspection_block_station_idx on meganet.inspection_block (station_id);
create index if not exists inspection_block_key_idx on meganet.inspection_block (station_key);

drop trigger if exists inspection_block_touch_updated_at on meganet.inspection_block;
create trigger inspection_block_touch_updated_at before update on meganet.inspection_block
  for each row execute function meganet.touch_updated_at();

-- Now the foreign key from a visit to its block. Added after the table exists,
-- and `not valid` is deliberately not used: there is nothing in the column yet.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'inspection_source_block_fkey'
                    and conrelid = 'meganet.inspection'::regclass) then
    alter table meganet.inspection
      add constraint inspection_source_block_fkey
      foreign key (source_block_ref) references meganet.inspection_block (ref) on delete set null;
  end if;
end
$$;

-- The facts on the block's `ID's` line. A list rather than columns, because a
-- station has as many ALERT addresses as it has sensors and because the line is
-- not the same set twice.

create table if not exists meganet.block_fact_kind (
  key    text primary key,
  ord    integer not null,
  label  text    not null,
  note   text    not null default ''
);

comment on table meganet.block_fact_kind is
  'What can appear on a station block''s `ID''s` line. Read off the workbook, not invented: six kinds across 1,093 blocks.';

insert into meganet.block_fact_kind (key, ord, label, note) values
  ('rain_alert_id',     1, 'Rain ALERT ID',    'Written `Rn = 5858`. 562 blocks.'),
  ('river_alert_id',    2, 'River ALERT ID',   'Written `Rv = 5859`. 331 blocks.'),
  ('battery_alert_id',  3, 'Battery ALERT ID', 'Written `Batt = 5860`. 638 blocks.'),
  ('orifice_level_raw', 4, 'Orifice level',    'The surveyed level of the gas orifice, in the block''s own words — `10.177 AHD as of 7/12/18`. Dated, which is why the fact carries an `as_at`. 249 blocks.'),
  ('key_number_raw',    5, 'Key number',       'Gate or cabinet key. 70 blocks.'),
  ('phone_no_raw',      6, 'Telephone number', 'Mace and telephone-telemetry sites. 39 blocks.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label, note = excluded.note;

create table if not exists meganet.inspection_block_fact (
  block_ref   text    not null references meganet.inspection_block (ref) on delete cascade,
  fact_key    text    not null references meganet.block_fact_kind (key),
  ord         integer not null default 1,

  -- The workbook's words, always. This is the column of record.
  value_raw   text    not null,
  -- A number where the fact is one — an ALERT address, a level in metres.
  value_num   numeric,
  -- Orifice levels are surveyed and re-surveyed: `as of 7/12/18`. Null when the
  -- workbook did not date the fact, which is the common case.
  as_at       date,
  as_at_raw   text    not null default '',

  primary key (block_ref, fact_key, ord)
);

comment on table meganet.inspection_block_fact is
  'The `ID''s` line, split. Per station block rather than per visit, because that is the grain the workbook records them at — and per *block* rather than per station, because a station written up on two sheets in two decades may have been re-surveyed in between.';
comment on column meganet.inspection_block_fact.as_at is
  'When the fact was true, where the workbook says. An orifice level of `10.177 AHD as of 7/12/18` is not a claim about today.';

create index if not exists inspection_block_fact_kind_idx
  on meganet.inspection_block_fact (fact_key, value_num);

-- ─────────────────────────────────────────────────────────────────────────────
-- §6. The measurement vocabulary, and where each field goes
-- ─────────────────────────────────────────────────────────────────────────────
-- This table is what stops the historical load being a parallel schema. Every
-- field the extractor can emit is named here once, with the section it belongs
-- to and — where the current form has somewhere to put it — the exact table and
-- column a form submission would write it to.
--
-- That correspondence is data, not a comment and not a dictionary buried in
-- Python: §9's projection function reads it to fan the measurements out into
-- 0009's section tables, and `tools/check_inspection_history.sql` reads it to
-- prove the two agree. A field whose `home_table` is empty is one the current
-- form has no box for; it is kept in full in §7 and it is *not* dropped.

create table if not exists meganet.measurement_class (
  key    text primary key,
  ord    integer not null,
  label  text    not null,
  rule   text    not null default ''
);

comment on table meganet.measurement_class is
  'What kind of thing a workbook cell held. The counts and the rules are docs/inspection-workbook-parse-spec.md §5, measured over the file rather than guessed.';

insert into meganet.measurement_class (key, ord, label, rule) values
  ('number',           1, 'Number',            'A numeric cell. Both `value` and `raw` are set.'),
  ('numeric_text',     2, 'Number as text',    'A number Excel stored as a string. `value` and `raw`.'),
  ('number_with_unit', 3, 'Number with unit',  '`10.4mm`, `13v`. `value`, `unit` and `raw`.'),
  ('qualified',        4, 'Bound',             '`<1`, `>30`. `operator` and `bound` are set and `value` is NULL — the true reading is unknown and any point estimate would be fabricated.'),
  ('status',           5, 'Status word',       '`-`, `U/S`, `N/M`. `status` is set and `value` is NULL.'),
  ('range',            6, 'Two in one cell',   '`4/0.5`, `30/600`. Raw only, flagged: the parser will not guess which number is which.'),
  ('short_text',       7, 'Short text',        'A word or two where a number was expected. Raw only, flagged.'),
  ('prose',            8, 'Prose',             'Over forty characters — "Unable to access battery box". Raw only, flagged, and usually the most informative thing on the row.'),
  ('error',            9, 'Excel error',       '`#VALUE!`, `#REF!` baked into the sheet. Raw only, flagged.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label, rule = excluded.rule;

create table if not exists meganet.measurement_status (
  key       text primary key,
  ord       integer not null,
  label     text    not null,
  -- Several of these are the same word spelled differently by different
  -- technicians over thirty years. `canonical` says which one they mean; the
  -- key stays as written so the cell can still be recognised.
  canonical text    not null,
  means     text    not null default ''
);

comment on table meganet.measurement_status is
  'The closed list of status words that appear where a reading should be. `-` is the commonest non-numeric cell in the workbook and it is *not* an empty cell: empty means nobody wrote anything, `-` means there was nothing to measure.';

insert into meganet.measurement_status (key, ord, label, canonical, means) values
  ('-',          1, '-',           '-',          'Not applicable or nothing to measure. 1,324 cells — deliberately distinct from an empty cell.'),
  ('--',         2, '--',          '-',          'As above, written twice.'),
  ('n/m',        3, 'N/M',         'n/m',        'Not measured on this visit.'),
  ('nm',         4, 'NM',          'n/m',        'As above.'),
  ('n/a',        5, 'N/A',         'n/a',        'Not applicable to this station.'),
  ('na',         6, 'NA',          'n/a',        'As above.'),
  ('n/r',        7, 'N/R',         'n/r',        'Not recorded.'),
  ('u/s',        8, 'U/S',         'u/s',        'Unserviceable — the equipment was broken, which is a reading in itself.'),
  ('?',          9, '?',           '?',          'The technician was unsure of the value.'),
  ('x',         10, 'X',           'x',          'Struck out.'),
  ('ok',        11, 'OK',          'ok',         'Checked and satisfactory, without a number.'),
  ('nil',       12, 'Nil',         'nil',        'Zero, written as a word — kept apart from a measured 0.'),
  ('reset',     13, 'Reset',       'reset',      'The equipment was reset rather than read.'),
  ('not tested',14, 'Not tested',  'n/m',        'Not measured, written out.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label,
                                canonical = excluded.canonical, means = excluded.means;

create table if not exists meganet.measurement_field (
  key         text primary key,
  ord         integer not null,
  label       text    not null,
  unit        text    not null default '',
  section_key text    not null references meganet.inspection_section (key),

  -- Where a form submission would put the same fact. Empty when the current
  -- form has no box for it — which is a real answer, not a gap to be fixed.
  home_table  text    not null default '',
  home_column text    not null default '',
  -- For the fields that land as calibration rows rather than as a column.
  kind_key    text    references meganet.calibration_kind (key),
  -- For the fields that land as a serial-number row.
  equipment_key text  references meganet.equipment_kind (key),
  -- Which *box* on the sheet, where a station has more than one of a kind.
  -- `canister_no` and `canister_type` are two columns describing one canister
  -- and become one row; `receiver1_serial` and `receiver2_serial` are the same
  -- kind of equipment twice over and must not be merged.
  equipment_slot text not null default '',

  note        text    not null default ''
);

comment on table meganet.measurement_field is
  'Every field #124''s extractor can emit, and the column on 0009''s tables that holds the same fact. This mapping is the reason the historical load is not a parallel schema: it is data, meganet.project_inspection_measurements() reads it to populate the section tables, and the smoke test reads it to prove they agree.';
comment on column meganet.measurement_field.home_table is
  'Empty means the current form has no box for this field. The measurement is still stored in full — see meganet.inspection_measurement — it simply has no column to be projected into.';

insert into meganet.measurement_field
  (key, ord, label, unit, section_key, home_table, home_column, kind_key, equipment_key, note) values
  -- Power. The largest group, and the one the current form has drifted from.
  ('battery_standby_v',            10, 'Battery voltage, standby',  'V',  'battery', 'inspection_power', 'battery_existing_v',            null, null, ''),
  ('battery_under_load_v',         11, 'Battery under load',        'V',  'battery', 'inspection_power', 'battery_existing_v_under_load', null, null, ''),
  ('lithium_battery_v',            12, 'Lithium battery',           'V',  'battery', 'inspection_power', 'lithium_battery_v',             null, null, ''),
  ('battery_test_raw',             13, 'Battery tester (V/CCA)',    '',   'battery', 'inspection_power', 'comments',                      null, null, 'Argus tester, two numbers in one cell. Lands in the comments rather than being split into a precision the cell does not carry.'),
  ('consumption_standby_ma',       14, 'Consumption, standby',      'mA', 'battery', 'inspection_power', 'consumption_standby_ma',        null, null, 'Column added by this migration — see §1.'),
  ('consumption_transmit_ma',      15, 'Consumption, transmit',     'mA', 'battery', 'inspection_power', 'consumption_transmit_ma',       null, null, 'Column added by this migration.'),
  ('consumption_sleep_ma',         16, 'Consumption, sleep',        'mA', 'battery', 'inspection_power', 'consumption_sleep_ma',          null, null, ''),
  ('consumption_operating_ma',     17, 'Consumption, operating',    'mA', 'battery', 'inspection_power', 'consumption_operating_ma',      null, null, ''),
  ('consumption_interrogation_ma', 18, 'Consumption, interrogation','mA', 'battery', 'inspection_power', 'consumption_interrogation_ma',  null, null, ''),
  ('telephone_socket_v',           19, 'Voltage at phone socket',   'V',  'battery', 'inspection_power', 'telephone_socket_v',            null, null, 'Mace sites. A field that exists then and not now.'),
  ('dp_battery_v',                 20, 'DP battery',                'V',  'battery', 'inspection_power', 'dp_existing_v',                 null, null, ''),
  ('solar_output_v',               21, 'Solar output',              'V',  'power_supply', 'inspection_power', 'solar_output_v',           null, null, ''),
  ('solar_short_circuit_ma',       22, 'Solar short circuit',       'mA', 'power_supply', 'inspection_power', 'solar_short_circuit_ma',   null, null, ''),
  ('solar_regulated_v',            23, 'Solar regulated',           'V',  'power_supply', 'inspection_power', 'solar_regulator_v',        null, null, ''),
  ('solar_charge_current_ma',      24, 'Solar charge current',      'mA', 'power_supply', 'inspection_power', 'solar_charge_current_ma',  null, null, ''),
  ('solar_step_up_v',              25, 'Solar step-up',             'V',  'power_supply', 'inspection_power', 'solar_step_up_v',          null, null, ''),
  ('mains_charge_current_ma',      26, 'Mains charge current',      'mA', 'power_supply', 'inspection_power', 'mains_charge_current_ma',  null, null, 'Column added by this migration.'),
  ('mains_regulated_v',            27, 'Mains regulated',           'V',  'power_supply', 'inspection_power', 'mains_regulated_v',        null, null, 'Column added by this migration.'),

  -- Radio.
  ('tx_forward_w',        30, 'Transmitter forward power',  'W',   'radio', 'inspection_radio', 'existing_forward_w',    null, null, ''),
  ('tx_reflected_w',      31, 'Transmitter reflected power','W',   'radio', 'inspection_radio', 'existing_reflected_w',  null, null, ''),
  ('swr',                 32, 'SWR',                        '',    'radio', 'inspection_radio', 'existing_swr',          null, null, ''),
  ('tx_size_w',           33, 'Transmitter size',           'W',   'radio', 'inspection_radio', 'tx_size_w',             null, null, ''),
  ('tx_deviation_khz',    34, 'Transmitter deviation',      'kHz', 'radio', 'inspection_radio', 'tx_deviation_khz',      null, null, 'Column added by this migration.'),
  ('antenna_forward_w',   35, 'Antenna forward power',      'W',   'radio', 'inspection_radio', 'replacement_forward_w', null, null, 'The historical sheets print a second antenna test beside the first; 0009''s replacement-antenna columns are the same three boxes.'),
  ('antenna_reflected_w', 36, 'Antenna reflected power',    'W',   'radio', 'inspection_radio', 'replacement_reflected_w', null, null, ''),
  ('antenna_swr',         37, 'Antenna SWR',                '',    'radio', 'inspection_radio', 'replacement_swr',       null, null, ''),
  ('antenna_frequency_mhz',38,'Antenna frequency',          'MHz', 'radio', 'inspection_radio', 'existing_frequency_mhz',null, null, ''),
  ('fade_margin_db',      39, 'Fade margin',                'dB',  'radio', 'inspection_fade_margin', 'load_db',         null, null, 'One reading per visit on the historical sheets, so it lands as the `this_visit` row rather than as a table of passes. 7,322 rows, and 606 of them are `>30` — a meter that stopped, not a measurement of 30.'),

  -- Readings on arrival.
  ('rssi_dbm',            40, 'RSSI',                       'dBm', 'initial_data', 'inspection_data', 'rssi_dbm',         null, null, ''),
  ('gas_pressure_kpa',    41, 'Gas pressure',               'kPa', 'initial_data', 'inspection_data', 'gas_pressure_kpa', null, null, ''),
  ('dp_counter',          42, 'DP counter',                 '',    'initial_data', 'inspection_data', 'dp_counter',       null, null, 'Mace differential-pressure counter.'),

  -- Gas.
  ('cylinder_pressure_kpa',            50, 'Cylinder pressure',             'kPa', 'gas', 'inspection_gas', 'existing_cylinder_pressure_kpa',    null, null, ''),
  ('replacement_cylinder_pressure_kpa',51, 'Replacement cylinder pressure', 'kPa', 'gas', 'inspection_gas', 'replacement_cylinder_pressure_kpa', null, null, ''),
  ('feed_pressure_kpa',                52, 'Feed pressure',                 'kPa', 'gas', 'inspection_gas', 'existing_feed_pressure_kpa',        null, null, ''),
  ('bubble_rate_bpm',                  53, 'Bubble rate',                   'bpm', 'gas', 'inspection_gas', 'existing_bubble_rate_bpm',          null, null, ''),
  ('gas_consumption_kpa_month',        54, 'Gas consumption',               'kPa/month', 'gas', 'inspection_gas', 'consumption_kpa_per_month',   null, null, ''),
  ('gas_pump_cycle_kpa',               55, 'Compressor pump cycle from',    'kPa', 'gas', 'inspection_gas', 'compressor_pump_cycle_from_kpa',    null, null, ''),

  -- Water level.
  ('analogue_range_m',                 60, 'Analogue range',                'm',  'water_level', 'inspection_water_level', 'transmitter_range',              null, null, ''),
  ('shaft_encoder_increments_per_rev', 61, 'Increments per revolution',     '',   'water_level', 'inspection_water_level', 'shaft_encoder_increments_per_rev', null, null, ''),

  -- Serial numbers.
  ('canister_no',      70, 'Canister number', '', 'serial_numbers', 'inspection_serial', 'serial_no', null, 'canister', ''),
  ('canister_type',    71, 'Canister type',   '', 'serial_numbers', 'inspection_serial', 'model',     null, 'canister', ''),
  ('logger_no',        72, 'Logger number',   '', 'serial_numbers', 'inspection_serial', 'serial_no', null, 'logger',   'Logger or Mace serial.'),
  ('decoder_serial',   73, 'Decoder serial',  '', 'serial_numbers', 'inspection_serial', 'serial_no', null, 'decoder',  ''),
  ('receiver1_serial', 74, 'Receiver 1 serial','', 'serial_numbers','inspection_serial', 'serial_no', null, 'receiver', ''),
  ('receiver2_serial', 75, 'Receiver 2 serial','', 'serial_numbers','inspection_serial', 'serial_no', null, 'receiver', ''),

  -- Calibration rows.
  ('tbrg_calibration_mm',           80, 'TBRG calibration',        'mm', 'rain_gauge',  'inspection_calibration', 'result',      'rain_tip_test',     null, ''),
  ('river_calibration_point',       81, 'River calibration point', '',   'water_level', 'inspection_calibration', 'result',      'river_calibration', null, 'The reading; `point` on the measurement row is the header label it was taken at.'),
  ('shaft_encoder_revs',            82, 'Shaft encoder revolutions','',  'water_level', 'inspection_calibration', 'revolutions', 'shaft_encoder',     null, ''),
  ('shaft_encoder_result',          83, 'Shaft encoder result',    '',   'water_level', 'inspection_calibration', 'result',      'shaft_encoder',     null, ''),
  ('shaft_encoder_error',           84, 'Shaft encoder error',     'm',  'water_level', 'inspection_calibration', 'error_m',     'shaft_encoder',     null, ''),
  ('shaft_encoder_accum_diff',      85, 'Shaft encoder difference','',   'water_level', 'inspection_calibration', 'difference',  'shaft_encoder',     null, ''),
  ('shaft_encoder_count_direction', 86, 'Count direction',         '',   'water_level', 'inspection_calibration', 'notes',       'shaft_encoder',     null, ''),
  ('decoder_v',                     87, 'Decoder test',            'V',  'base_tests',  'inspection_calibration', 'measured',    'decoder_test',      null, 'On ALERT blocks as well as base stations — see §3.'),
  ('receiver_v',                    88, 'Receiver test',           'V',  'base_tests',  'inspection_calibration', 'measured',    'receiver_test',     null, ''),
  ('supply_v',                      89, 'Supply from decoder',     'V',  'base_tests',  'inspection_calibration', 'supply_v',    'receiver_test',     null, ''),

  -- Fields that land on meganet.inspection itself. Named here so the vocabulary
  -- is the whole vocabulary and a reader is not left wondering where they went.
  ('station_number', 90, 'Station number', '', 'station_details', 'inspection', 'cbm_no',       null, null, 'Written to the visit row, not to a measurement row.'),
  ('station_name',   91, 'Station name',   '', 'station_details', 'inspection', 'station_name', null, null, 'As above.'),
  ('inspect_date',   92, 'Inspection date','', 'station_details', 'inspection', 'inspected_on', null, null, 'As above. The only field whose absence disqualifies a row.'),
  ('remarks',        93, 'Remarks',        '', 'remarks',         'inspection', 'remarks',      null, null, 'As above.')
on conflict (key) do update
  set ord = excluded.ord, label = excluded.label, unit = excluded.unit,
      section_key = excluded.section_key, home_table = excluded.home_table,
      home_column = excluded.home_column, kind_key = excluded.kind_key,
      equipment_key = excluded.equipment_key, note = excluded.note;

-- The slots, set separately so the table above stays a readable list of fields.
-- One canister described by two columns is one row; two receivers described by
-- one column each are two.
update meganet.measurement_field set equipment_slot = v.slot
  from (values ('canister_no', 'canister'), ('canister_type', 'canister'),
               ('logger_no', 'logger'),     ('decoder_serial', 'decoder'),
               ('receiver1_serial', 'receiver1'),
               ('receiver2_serial', 'receiver2')) as v (key, slot)
 where meganet.measurement_field.key = v.key
   and meganet.measurement_field.equipment_slot is distinct from v.slot;

-- ─────────────────────────────────────────────────────────────────────────────
-- §7. The cell, as it was written
-- ─────────────────────────────────────────────────────────────────────────────
-- The parse spec's §5 rule, made a table: *the source string is retained in
-- every case*. One row per measured cell — 151,532 of them — carrying what the
-- spreadsheet held and, beside it, whatever interpretation the rules in
-- meganet.measurement_class licensed.
--
-- Three things this buys that a numeric column cannot:
--
--   * `>30` survives as `>30`. `operator` and `bound` carry the claim that was
--     actually made, and `value` stays null, so nothing downstream can mistake
--     a meter that ran out of scale for a reading of thirty.
--   * A field with no `home_table` — a Mace interrogation current, a phone
--     socket voltage on a layout 0009 never saw — is stored here in full rather
--     than dropped for want of a column.
--   * `source_col` finishes the address the visit row starts. Sheet, block,
--     row, column: an auditor doubting a number can open the cell.

create table if not exists meganet.inspection_measurement (
  inspection_id uuid    not null references meganet.inspection (id) on delete cascade,
  ord           integer not null,

  -- Null when the workbook printed a column this vocabulary has no name for.
  -- `label` always holds the sheet's own header, so an unmapped column is still
  -- a readable observation rather than an anonymous number.
  field_key     text    references meganet.measurement_field (key),
  label         text    not null default '',
  source_col    text    not null default '',

  -- For a calibration reading: the point it was taken at, in the block's units.
  point         numeric,

  -- The column of record.
  raw           text    not null,

  value_class   text    not null references meganet.measurement_class (key),
  -- Set for number, numeric_text and number_with_unit; null for everything else,
  -- and null is load-bearing — see the class table's rules.
  value         numeric,
  unit          text    not null default '',
  -- Set for `qualified` and only for it.
  operator      text    check (operator is null or operator in ('<', '>')),
  bound         numeric,
  -- Set for `status` and only for it.
  status        text    references meganet.measurement_status (key),
  -- What the parser wants a reader to know about this cell.
  flag          text    not null default ''
                        check (flag in ('', 'text_where_a_number_was_expected',
                                        'two_readings_in_one_cell', 'excel_error')),

  primary key (inspection_id, ord),

  -- The interpretation has to match the class it claims. This is the constraint
  -- that stops a `>30` acquiring a point estimate in some later migration.
  constraint inspection_measurement_class_agrees check (
    case value_class
      when 'qualified' then operator is not null and value is null
      when 'status'    then status   is not null and value is null
      when 'number'    then operator is null and status is null
      when 'numeric_text'     then operator is null and status is null
      when 'number_with_unit' then operator is null and status is null
      else value is null and operator is null
    end
  )
);

comment on table meganet.inspection_measurement is
  'One workbook cell, as it was written and as far as it could honestly be read. `raw` is authoritative; `value` is an interpretation and is null wherever the rules did not license one. This is the raw companion the parse spec §5 requires for every numeric column in the domain.';
comment on column meganet.inspection_measurement.raw is
  'The cell. Never null, never normalised, never repaired — #122''s non-goals are explicit that a transcription error in the archive stays in the archive, flagged.';
comment on column meganet.inspection_measurement.bound is
  'The number beside the operator in a qualified value. `>30` is operator `>` and bound 30, and `value` stays null: the reading is unknown and above thirty, which is a different fact from thirty.';
comment on column meganet.inspection_measurement.point is
  'For a river-calibration reading, the point it was taken at — the numeric header label, in the block''s own units. Per block, and per point row inside the block; never inferred from ord.';

create index if not exists inspection_measurement_field_idx
  on meganet.inspection_measurement (field_key, value);
create index if not exists inspection_measurement_flagged_idx
  on meganet.inspection_measurement (value_class) where value is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- §8. The rows that did not make it
-- ─────────────────────────────────────────────────────────────────────────────
-- #122's acceptance: every ingestable row is either loaded or in the rejects
-- file with a reason, and the two counts reconcile. A rejects file on somebody's
-- disk cannot be reconciled against a database, so the rejects come too. 153 of
-- them, against 14,982 loaded.

create table if not exists meganet.inspection_reject_reason (
  key   text primary key,
  ord   integer not null,
  label text    not null,
  note  text    not null default ''
);

insert into meganet.inspection_reject_reason (key, ord, label, note) values
  ('excel_error_row',        1, 'Excel error in the row',   'A `#VALUE!` or `#REF!` baked into the sheet where the reading should be.'),
  ('undated_data',           2, 'Readings with no date',    'A row of measurements with nothing in the date cell at all. The date is the one field whose absence disqualifies a row.'),
  ('malformed_date',         3, 'Malformed date',           'A date cell that no rule could read.'),
  ('text_in_the_date_cell',  4, 'Text in the date cell',    'A word where the date belongs.'),
  ('implausible_date',       5, 'Implausible date',         'Parsed cleanly and landed outside 1980-2025 — `23/6/215`, or Excel''s 1900-01-03 sentinel. Obviously 2015 to a person and not to a rule, so it is rejected rather than repaired: #122''s non-goals forbid correcting the record.'),
  ('repeat_header_row',      6, 'Repeated header',          'A header band printed again inside the data.'),
  ('orphan_identifier',      7, 'Orphan identifier',        'An identifier with no block above it to belong to.')
on conflict (key) do update set ord = excluded.ord, label = excluded.label, note = excluded.note;

create table if not exists meganet.inspection_reject (
  ref        text    primary key,
  source     text    not null default '',
  sheet      text    not null default '',
  banner_row integer,
  row_no     integer,
  block_ref  text,
  level      text    not null default 'row' check (level in ('row', 'block')),
  reason     text    not null references meganet.inspection_reject_reason (key),
  detail     text    not null default '',
  row_class  text    not null default '',
  -- The cells that were on the row, so a person deciding what to do about it
  -- does not have to open the workbook to see what is at stake.
  cells      jsonb   not null default '{}'::jsonb
);

comment on table meganet.inspection_reject is
  'A row the extractor would not load, with its address and its reason. Loaded and rejected together account for every inspection row in the workbook — meganet.inspection_history_reconciliation is that sum.';

create index if not exists inspection_reject_reason_idx on meganet.inspection_reject (reason);
create index if not exists inspection_reject_sheet_idx  on meganet.inspection_reject (sheet, row_no);

-- ─────────────────────────────────────────────────────────────────────────────
-- §9. Projecting the measurements into the section tables
-- ─────────────────────────────────────────────────────────────────────────────
-- The measurements are the record; the section tables are how the rest of
-- MegaNet already asks questions. This function fills the second from the first,
-- driven entirely by meganet.measurement_field — so the mapping lives in one
-- place, and fixing a mis-mapped field is an update to that table plus one call
-- to this, rather than a re-extract of a 7 MB spreadsheet.
--
-- Only `value` is projected. A bound, a status word or a sentence has no number
-- and so lands in no numeric column; it stays in §7, where it is complete. That
-- is not data loss — it is the difference between the two tables, and it is the
-- reason both exist.

create or replace function meganet.project_inspection_measurements(p_only uuid[] default null)
returns table (home text, rows_written bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_cols   text;
  v_sel    text;
  v_set    text;
  v_count  bigint;
begin
  -- The single-row-per-visit section tables, generically. Each one is an
  -- aggregate over the visit's measurements: one column per mapped field,
  -- picking the value of the measurement that claims that field.
  for r in
    select f.home_table,
           pg_catalog.string_agg(pg_catalog.quote_ident(f.home_column), ', '
                                 order by f.home_column) as cols,
           pg_catalog.string_agg(
             pg_catalog.format('max(m.value) filter (where m.field_key = %L)', f.key), ', '
             order by f.home_column) as sel,
           pg_catalog.string_agg(
             pg_catalog.format('%1$I = excluded.%1$I', f.home_column), ', '
             order by f.home_column) as upd,
           -- Only this table's own fields, so that a visit carrying a battery
           -- reading and nothing else does not acquire an empty gas row — which
           -- the section guard would rightly refuse on a base station.
           pg_catalog.string_agg(pg_catalog.quote_literal(f.key), ', '
                                 order by f.key) as fields
      from meganet.measurement_field f
     where f.home_table in ('inspection_power', 'inspection_radio',
                            'inspection_gas', 'inspection_water_level')
       and f.home_column <> ''
       -- Only the numeric columns: `comments` and `transmitter_range` are text
       -- and are written by the loader, not projected.
       and exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = ('meganet.' || f.home_table)::regclass
                      and a.attname  = f.home_column
                      and a.atttypid = 'numeric'::regtype)
     group by f.home_table
  loop
    v_cols := r.cols; v_sel := r.sel; v_set := r.upd;
    execute pg_catalog.format($fmt$
      insert into meganet.%1$I (inspection_id, %2$s)
      select m.inspection_id, %3$s
        from meganet.inspection_measurement m
        join meganet.inspection i on i.id = m.inspection_id
       where i.origin = 'import'
         and m.field_key in (%5$s)
         and m.value is not null
         and ($1 is null or m.inspection_id = any($1))
       group by m.inspection_id
      on conflict (inspection_id) do update set %4$s
    $fmt$, r.home_table, v_cols, v_sel, v_set, r.fields) using p_only;
    get diagnostics v_count = row_count;
    home := r.home_table; rows_written := v_count; return next;
  end loop;

  -- Readings on arrival. Phase `initial`, because the historical sheets record
  -- one set of numbers per visit rather than the modern form's two.
  insert into meganet.inspection_data (inspection_id, phase, rssi_dbm, gas_pressure_kpa, dp_counter)
  select m.inspection_id, 'initial',
         max(m.value) filter (where m.field_key = 'rssi_dbm'),
         max(m.value) filter (where m.field_key = 'gas_pressure_kpa'),
         max(m.value) filter (where m.field_key = 'dp_counter')
    from meganet.inspection_measurement m
    join meganet.inspection i on i.id = m.inspection_id
   where i.origin = 'import'
     and m.field_key in ('rssi_dbm', 'gas_pressure_kpa', 'dp_counter')
     and m.value is not null
     and (p_only is null or m.inspection_id = any(p_only))
   group by m.inspection_id
  on conflict (inspection_id, phase) do update
    set rssi_dbm = excluded.rssi_dbm,
        gas_pressure_kpa = excluded.gas_pressure_kpa,
        dp_counter = excluded.dp_counter;
  get diagnostics v_count = row_count;
  home := 'inspection_data'; rows_written := v_count; return next;

  -- Fade margin. One reading per historical visit, so `this_visit` ord 1 —
  -- the sheet's ORIGINAL column group is a modern addition.
  insert into meganet.inspection_fade_margin (inspection_id, phase, ord, load_db)
  select m.inspection_id, 'this_visit', 1, max(m.value)
    from meganet.inspection_measurement m
    join meganet.inspection i on i.id = m.inspection_id
   where i.origin = 'import' and m.field_key = 'fade_margin_db' and m.value is not null
     and (p_only is null or m.inspection_id = any(p_only))
   group by m.inspection_id
  on conflict (inspection_id, phase, ord) do update set load_db = excluded.load_db;
  get diagnostics v_count = row_count;
  home := 'inspection_fade_margin'; rows_written := v_count; return next;

  -- Serial numbers. A row per piece of equipment the block named, ordered by
  -- the vocabulary so the list is stable across re-runs.
  insert into meganet.inspection_serial (inspection_id, ord, equipment_key, label, model, serial_no)
  select inspection_id,
         pg_catalog.row_number() over (partition by inspection_id order by slot_ord)::int,
         equipment_key, label, model, serial_no
    from (
      select m.inspection_id,
             min(f.ord)         as slot_ord,
             f.equipment_key,
             coalesce(min(f.label) filter (where f.home_column = 'serial_no'),
                      min(f.label), '')                                    as label,
             coalesce(pg_catalog.string_agg(m.raw, ' ')
                        filter (where f.home_column = 'model'), '')        as model,
             coalesce(pg_catalog.string_agg(m.raw, ' ')
                        filter (where f.home_column = 'serial_no'), '')    as serial_no
        from meganet.inspection_measurement m
        join meganet.measurement_field f on f.key = m.field_key
        join meganet.inspection i on i.id = m.inspection_id
       where i.origin = 'import' and f.home_table = 'inspection_serial'
         and (p_only is null or m.inspection_id = any(p_only))
       group by m.inspection_id, f.equipment_key, f.equipment_slot
    ) s
  on conflict (inspection_id, ord) do update
    set equipment_key = excluded.equipment_key, label = excluded.label,
        model = excluded.model, serial_no = excluded.serial_no;
  get diagnostics v_count = row_count;
  home := 'inspection_serial'; rows_written := v_count; return next;

  -- Calibration. The river grid is one row per point, ordered by the point
  -- itself; every other kind is a single row whose columns come from the
  -- vocabulary's home_column.
  insert into meganet.inspection_calibration
         (inspection_id, kind_key, phase, ord, units, expected_result, result)
  select m.inspection_id, 'river_calibration', 'none',
         pg_catalog.row_number() over (partition by m.inspection_id order by m.point, m.ord)::int,
         '', m.point, m.value
    from meganet.inspection_measurement m
    join meganet.inspection i on i.id = m.inspection_id
   where i.origin = 'import' and m.field_key = 'river_calibration_point'
     -- Six cells in the archive sit under a calibration column whose point a
     -- point row inside the data had already redefined, and the extractor
     -- declined to say which point they were taken at. A calibration row that
     -- cannot say what it is a calibration *of* is worse than no row: it is the
     -- silent rescaling the parse spec §4 warns about. They stay complete in
     -- meganet.inspection_measurement and are not projected.
     and m.point is not null
     and (p_only is null or m.inspection_id = any(p_only))
  on conflict (inspection_id, kind_key, phase, ord) do update
    set expected_result = excluded.expected_result, result = excluded.result;
  get diagnostics v_count = row_count;
  home := 'inspection_calibration:river_calibration'; rows_written := v_count; return next;

  insert into meganet.inspection_calibration
         (inspection_id, kind_key, phase, ord, result, revolutions, error_m, difference, measured, supply_v, notes)
  select m.inspection_id, f.kind_key, 'none', 1,
         max(m.value) filter (where f.home_column = 'result'),
         max(m.value) filter (where f.home_column = 'revolutions'),
         max(m.value) filter (where f.home_column = 'error_m'),
         max(m.value) filter (where f.home_column = 'difference'),
         max(m.value) filter (where f.home_column = 'measured'),
         max(m.value) filter (where f.home_column = 'supply_v'),
         coalesce(pg_catalog.string_agg(m.raw, '; ') filter (where f.home_column = 'notes'), '')
    from meganet.inspection_measurement m
    join meganet.measurement_field f on f.key = m.field_key
    join meganet.inspection i on i.id = m.inspection_id
   where i.origin = 'import'
     and f.home_table = 'inspection_calibration'
     and f.kind_key is not null and f.kind_key <> 'river_calibration'
     and (p_only is null or m.inspection_id = any(p_only))
   group by m.inspection_id, f.kind_key
  on conflict (inspection_id, kind_key, phase, ord) do update
    set result = excluded.result, revolutions = excluded.revolutions,
        error_m = excluded.error_m, difference = excluded.difference,
        measured = excluded.measured, supply_v = excluded.supply_v,
        notes = excluded.notes;
  get diagnostics v_count = row_count;
  home := 'inspection_calibration'; rows_written := v_count; return next;

  return;
end;
$$;

comment on function meganet.project_inspection_measurements(uuid[]) is
  'Fills 0009''s section tables from the imported measurements, driven by meganet.measurement_field. Idempotent: every statement upserts on the section table''s own key. Only values with a number are projected — a bound or a status word has none, and stays complete in meganet.inspection_measurement.';

-- ─────────────────────────────────────────────────────────────────────────────
-- §10. Accepting a station match later
-- ─────────────────────────────────────────────────────────────────────────────
-- #125 attributed 969 of the workbook's 1,051 identities. The other 82 are
-- parked: station_id null, station_name and cbm_no intact, station_key naming
-- the crosswalk entry that could not be decided. #122's acceptance asks for
-- exactly this — "or sit in an explicit unmatched bucket with the raw name/CBM
-- preserved" — and #126's asks that they be backfillable without a full reload.
--
-- This is that. It takes the same shape #125 writes, applies the ones a person
-- has decided, and touches nothing else.

create or replace function meganet.backfill_inspection_station(p_matches jsonb)
returns table (station_key text, station_id text, blocks_updated bigint, visits_updated bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  m         jsonb;
  v_key     text;
  v_station text;
  v_tier    text;
  v_blocks  bigint;
  v_visits  bigint;
begin
  if pg_catalog.jsonb_typeof(p_matches) <> 'array' then
    raise exception 'backfill_inspection_station() takes an array of {key, station_id, tier} objects'
      using errcode = '22023';
  end if;

  for m in select * from pg_catalog.jsonb_array_elements(p_matches) loop
    v_key     := m ->> 'key';
    v_station := m ->> 'station_id';
    v_tier    := coalesce(m ->> 'tier', 'name');

    if v_key is null or v_station is null then
      raise exception 'every match needs a key and a station_id; got %', m
        using errcode = '22023';
    end if;
    if not exists (select 1 from meganet.station s where s.id = v_station) then
      raise exception 'no station %', v_station using errcode = '23503';
    end if;

    update meganet.inspection_block b
       set station_id = v_station, station_match = v_tier
     where b.station_key = v_key;
    get diagnostics v_blocks = row_count;

    update meganet.inspection i
       set station_id = v_station, station_match = v_tier
     where i.station_key = v_key and i.origin = 'import';
    get diagnostics v_visits = row_count;

    station_key := v_key; station_id := v_station;
    blocks_updated := v_blocks; visits_updated := v_visits;
    return next;
  end loop;

  return;
end;
$$;

comment on function meganet.backfill_inspection_station(jsonb) is
  'Attributes parked historical inspections to a station, one crosswalk key at a time. The reason the load does not have to wait for #125''s last 82 identities to be decided, and the reason deciding one later is not a reload.';

-- ─────────────────────────────────────────────────────────────────────────────
-- §11. Reading it back
-- ─────────────────────────────────────────────────────────────────────────────

-- What #128 renders. One row per visit, both origins, with the things that
-- distinguish them rather than in spite of them: where it came from, how
-- precisely it is dated, and whether anybody has decided which station it is.
create or replace view meganet.inspection_history
with (security_invoker = true) as
  select i.id,
         i.station_id,
         i.station_name,
         i.cbm_no,
         i.config_key,
         c.label as config_label,
         i.inspected_on,
         i.date_precision,
         i.date_raw,
         i.origin,
         i.station_match,
         i.inspector,
         i.remarks,
         i.source_workbook,
         i.source_sheet,
         i.source_block_ref,
         i.source_row,
         b.family      as block_family,
         b.property_owner,
         (select count(*) from meganet.inspection_measurement m where m.inspection_id = i.id)
           as measurement_count,
         (select count(*) from meganet.inspection_measurement m
           where m.inspection_id = i.id and m.value is null)
           as measurements_without_a_number
    from meganet.inspection i
    join meganet.inspection_config c on c.key = i.config_key
    left join meganet.inspection_block b on b.ref = i.source_block_ref
   where i.deleted_at is null;

comment on view meganet.inspection_history is
  'Every visit a station has had, typed or imported, in one shape. `origin` tells the two apart and `date_precision` says how much of the date the record actually claims — a 1990 row is an event, not a January the first.';

-- Where the archive recorded something the form has since stopped printing.
-- §3 makes this legal; this view makes it visible, so "we kept 264 readings the
-- current form has no box for" is a number somebody can check rather than a
-- claim in a comment.
create or replace view meganet.inspection_measurement_off_form
with (security_invoker = true) as
  select i.config_key,
         f.section_key,
         f.key as field_key,
         f.label,
         count(*) as measurements,
         count(distinct i.id) as visits,
         min(i.inspected_on) as first_seen,
         max(i.inspected_on) as last_seen
    from meganet.inspection_measurement m
    join meganet.inspection i on i.id = m.inspection_id
    join meganet.measurement_field f on f.key = m.field_key
    left join meganet.inspection_config_section cs
           on cs.config_key = i.config_key and cs.section_key = f.section_key
   where i.deleted_at is null
     and (cs.config_key is null or not cs.printed)
   group by i.config_key, f.section_key, f.key, f.label;

comment on view meganet.inspection_measurement_off_form is
  'Measurements whose section the configuration''s current form no longer prints. Not an error list — it is the history the schema deliberately kept, and its size is one of the numbers tools/check_inspection_history.sql asserts.';

-- #122's acceptance, as a query: loaded plus rejected accounts for everything.
create or replace view meganet.inspection_history_reconciliation
with (security_invoker = true) as
  select (select count(*) from meganet.inspection where origin = 'import' and deleted_at is null)
           as loaded,
         (select count(*) from meganet.inspection_reject)                    as rejected,
         (select count(*) from meganet.inspection_block)                     as blocks,
         (select count(*) from meganet.inspection_measurement)               as measurements,
         (select count(*) from meganet.inspection_measurement where value is null)
           as measurements_without_a_number,
         (select count(*) from meganet.inspection
           where origin = 'import' and station_id is null and deleted_at is null)
           as visits_not_yet_attributed,
         (select count(*) from meganet.inspection
           where origin = 'import' and date_precision <> 'day' and deleted_at is null)
           as visits_dated_loosely;

comment on view meganet.inspection_history_reconciliation is
  'The counts #122''s acceptance asks to be reconciled: loaded plus rejected against the workbook''s own total, and what is still parked. One row.';

-- ─────────────────────────────────────────────────────────────────────────────
-- §12. Row level security, and who may read
-- ─────────────────────────────────────────────────────────────────────────────
-- Same split as 0009, for the same reasons. The vocabularies describe a blank
-- form and are public. The records carry site access notes and property-owner
-- names — an archive of them, going back to the 1990s — and are editors only.

do $$
declare
  t text;
begin
  foreach t in array array[
      'measurement_class', 'measurement_status', 'measurement_field',
      'block_fact_kind', 'inspection_reject_reason',
      'inspection_block', 'inspection_block_fact', 'inspection_measurement',
      'inspection_reject'] loop
    execute pg_catalog.format('alter table meganet.%I enable row level security', t);
  end loop;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
      'measurement_class', 'measurement_status', 'measurement_field',
      'block_fact_kind', 'inspection_reject_reason'] loop
    execute pg_catalog.format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for select using (true)', t || '_read_all', t);
  end loop;
end
$$;

do $$
declare
  t text;
  v text;
begin
  foreach t in array array[
      'inspection_block', 'inspection_block_fact', 'inspection_measurement',
      'inspection_reject'] loop
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

-- Both functions write, so both have EXECUTE taken off PUBLIC. The projection
-- is granted to nothing a browser can reach: it is a load-time operation over
-- the whole table, and there is no reason for a signed-in user to be able to
-- start one.
revoke all on function meganet.project_inspection_measurements(uuid[]) from public;
revoke all on function meganet.backfill_inspection_station(jsonb)      from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on
      meganet.measurement_class, meganet.measurement_status, meganet.measurement_field,
      meganet.block_fact_kind, meganet.inspection_reject_reason
    to anon, authenticated;

  grant select on
      meganet.inspection_block, meganet.inspection_block_fact,
      meganet.inspection_measurement, meganet.inspection_reject,
      meganet.inspection_history, meganet.inspection_measurement_off_form,
      meganet.inspection_history_reconciliation
    to authenticated;

  grant select, insert, update, delete on
      meganet.measurement_class, meganet.measurement_status, meganet.measurement_field,
      meganet.block_fact_kind, meganet.inspection_reject_reason,
      meganet.inspection_block, meganet.inspection_block_fact,
      meganet.inspection_measurement, meganet.inspection_reject
    to service_role;

  grant execute on function meganet.backfill_inspection_station(jsonb)       to service_role;
  grant execute on function meganet.project_inspection_measurements(uuid[])  to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §13. Schema version
-- ─────────────────────────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '14')
on conflict (key) do update set value = excluded.value;
