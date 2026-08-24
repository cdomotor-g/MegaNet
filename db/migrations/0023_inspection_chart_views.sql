-- 0023_inspection_chart_views.sql — The inspection charts, without a sign-in.
--
-- Why this file exists
-- ────────────────────
-- The chart at the foot of the station editor card (station-inspections.js) is
-- thirty-five years of what a station has measured — fade margins, battery
-- volts, solar current, gas pressure — and until now nobody could see it
-- without signing in. Not because the numbers are sensitive, but because the
-- rows they are stored on are: 0009 grants the whole inspection domain to
-- editors and to nobody else, and db/README.md says why in one sentence —
--
--     "The Council form carries landowner names, emails and phone numbers, and
--      inspection remarks carry site access notes."
--
-- That is a fact about the *words* on an inspection, not about its numbers. A
-- fade margin of 18 dB in 1997 says nothing about who owns the paddock.
--
-- What this file does NOT do
-- ──────────────────────────
-- It does not grant `anon` a single row of `meganet.inspection` or of any
-- section table, and it does not add an anon policy to one. 0009's own comment
-- is the reason, and it is worth repeating because this is exactly the change
-- it was written against:
--
--     "the policies are what stands between a future `grant select … to anon`
--      and a published landowner phone number."
--
-- So the tables stay editors-only, exactly as they are, and the charts read
-- from seven purpose-built views instead. A view is a shape somebody chose: the
-- columns in it are the columns in it, and a column added to a base table later
-- does not appear in one. That is the whole safety property, and the assertions
-- at the foot of this file are it stated as SQL rather than as a promise.
--
-- Why definer views and not column grants
-- ───────────────────────────────────────
-- `grant select (col, col, …) on meganet.inspection_power to anon` plus an anon
-- read policy would work, is narrower per column, and is what "grants are as
-- narrow as the app needs" sounds like it asks for. It is rejected here for one
-- reason: it puts `for select to anon using (true)` on the record tables
-- themselves. From then on the sentence 0009 wrote is no longer true — the only
-- thing standing between `anon` and an inspection's remarks is a *column* list,
-- and the next person to write `grant select on meganet.inspection_power to
-- anon` (a plausible thing to type) publishes the comments column with it.
--
-- These views are `security_invoker = false` — the default, set here explicitly
-- because relying on a default for the thing that makes a view readable at all
-- is how it stops being readable. They run as their owner, so RLS on the base
-- tables does not apply to them, which is the whole mechanism. Every one of
-- them is a `select` with a written-out column list, so what they publish is
-- readable in this file with no catalogue queries.
--
-- Departing from a convention, and saying so
-- ──────────────────────────────────────────
-- Every one of the twelve views in db/migrations before this file carries
-- `security_invoker = true`, and 0002_stations.sql:322 states the rule:
--
--     "without it a view runs as its owner and reads straight past the RLS
--      policies above. Every base table here is world-readable so the result is
--      the same today — but the day one of them is not, the difference is a
--      data leak, and the correct setting costs nothing."
--
-- These seven are the first that do not, and 0002's sentence is why rather than
-- an objection to it: reading past the policy is not a side effect here, it is
-- the entire request. An invoker view over meganet.inspection returns `anon`
-- zero rows however it is granted, because `anon` has no SELECT policy on the
-- table underneath — which is the correct behaviour of a view that means "the
-- same rows, a narrower shape", and the wrong behaviour for one that means
-- "these columns, published".
--
-- 0002's warning survives intact, because the thing it protects against is a
-- view that leaks *what it did not mean to*. What these publish is fixed in
-- this file, checked by §4 below at apply time, and checked again by
-- tools/check_inspections.sql on every CI run. `security_invoker = true` on one
-- of them would not tighten anything — it would only turn the chart off.
--
-- What is published, exactly
-- ──────────────────────────
--   · when a visit happened, how precisely the date is known, and whether it
--     was typed into the app or imported from the archive workbook;
--   · the numbers that visit recorded, for the six section tables that hold one
--     number per visit.
--
-- No remarks. No inspector. No comments column. No serial numbers, no
-- attachments, no maintenance activity, no station_name or cbm_no as written on
-- the sheet, and none of the Council form. `station_id` is in the visit view
-- because a chart is per station and that is the key it is asked for by — and
-- it is the same slug stations.json has published on GitHub Pages since 0002.
--
-- The soft delete is honoured here rather than by the caller: every view joins
-- meganet.inspection and drops the rows with a `deleted_at`. A deleted visit is
-- deleted for an anonymous reader too, and not because the app remembered to
-- add a filter.
--
-- What changes in the app
-- ───────────────────────
-- station-inspections.js reads these views instead of the tables, for everybody
-- — signed in or out, one code path. Its `dbCanWrite()` gate goes with them.
-- The Inspection History tab is untouched: it renders the sheets as they were
-- written, which is the half that carries the words, and stays editors-only.

-- ─────────────────────────────────────────────────────────────────────────────
-- §1. The visits
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per live, station-attributed visit. `date_precision` is 0014's: a
-- 1990 row that only claims a year says so, and the chart plots it as an event
-- in that year rather than pretending to a day. `origin` tells a typed sheet
-- from an imported one, which is the difference the chart's own legend draws.
--
-- Deliberately absent, though the app used to ask for them: `date_raw` (the
-- date cell as a person wrote it — free text, and nothing reads it) and
-- `config_key` (which of the six sheets was printed — nothing reads that
-- either). A view is where a column earns its place by being used.

create or replace view meganet.inspection_chart_visit as
  select i.id,
         i.station_id,
         i.inspected_on,
         i.date_precision,
         i.origin
    from meganet.inspection i
   where i.deleted_at is null
     and i.station_id is not null;

comment on view meganet.inspection_chart_visit is
  'One row per live station visit: when, how precisely dated, and typed-here vs imported. No remarks, no inspector, no free text of any kind — the public half of meganet.inspection, for the station card''s chart (0023).';

-- ─────────────────────────────────────────────────────────────────────────────
-- §2. The numbers
-- ─────────────────────────────────────────────────────────────────────────────
-- One view per section table that holds a number per visit: the six that
-- station-inspections.js charts from, which are the same six 0014's
-- `measurement_field` names as a `home_table`.
--
-- The column lists are written out rather than generated, so that reviewing
-- what an anonymous visitor can read is reading this section. Every column in
-- them is `numeric`, bar the two discriminators named below. Notably absent
-- from every one: `comments`.
--
-- Two tables carry more than one row per visit and so keep the column the app
-- filters on:
--
--   inspection_data         `phase` — 'initial' or 'final'. The chart reads the
--                           arrival readings; 0014's projection writes only
--                           those, so a typed sheet and an imported one mean
--                           the same thing.
--   inspection_fade_margin  `phase` — 'original' or 'this_visit', and several
--                           `ord` rows within each. The chart folds them with
--                           max(), which is what 0014 writes for an import.
--
-- Both are `check`-constrained to a closed pair of words. They are not text in
-- the sense this file is careful about; they are an enum spelled as characters.

create or replace view meganet.inspection_chart_power as
  select p.inspection_id,
         p.battery_existing_v,
         p.battery_existing_v_under_load,
         p.lithium_battery_v,
         p.dp_existing_v,
         p.consumption_standby_ma,
         p.consumption_transmit_ma,
         p.consumption_sleep_ma,
         p.consumption_operating_ma,
         p.consumption_interrogation_ma,
         p.telephone_socket_v,
         p.solar_output_v,
         p.solar_short_circuit_ma,
         p.solar_regulator_v,
         p.solar_charge_current_ma,
         p.solar_step_up_v,
         p.mains_charge_current_ma,
         p.mains_regulated_v
    from meganet.inspection_power p
    join meganet.inspection i on i.id = p.inspection_id and i.deleted_at is null;

create or replace view meganet.inspection_chart_radio as
  select r.inspection_id,
         r.tx_size_w,
         r.tx_deviation_khz,
         r.existing_frequency_mhz,
         r.existing_forward_w,
         r.existing_reflected_w,
         r.existing_swr,
         r.replacement_forward_w,
         r.replacement_reflected_w,
         r.replacement_swr
    from meganet.inspection_radio r
    join meganet.inspection i on i.id = r.inspection_id and i.deleted_at is null;

create or replace view meganet.inspection_chart_gas as
  select g.inspection_id,
         g.existing_cylinder_pressure_kpa,
         g.replacement_cylinder_pressure_kpa,
         g.existing_feed_pressure_kpa,
         g.existing_bubble_rate_bpm,
         g.compressor_pump_cycle_from_kpa,
         g.consumption_kpa_per_month
    from meganet.inspection_gas g
    join meganet.inspection i on i.id = g.inspection_id and i.deleted_at is null;

create or replace view meganet.inspection_chart_water_level as
  select w.inspection_id,
         w.shaft_encoder_increments_per_rev
    from meganet.inspection_water_level w
    join meganet.inspection i on i.id = w.inspection_id and i.deleted_at is null;

create or replace view meganet.inspection_chart_data as
  select d.inspection_id,
         d.phase,
         d.rssi_dbm,
         d.gas_pressure_kpa,
         d.dp_counter
    from meganet.inspection_data d
    join meganet.inspection i on i.id = d.inspection_id and i.deleted_at is null;

create or replace view meganet.inspection_chart_fade_margin as
  select f.inspection_id,
         f.phase,
         f.load_db
    from meganet.inspection_fade_margin f
    join meganet.inspection i on i.id = f.inspection_id and i.deleted_at is null;

-- `security_invoker = false` is the default, and it is what makes these views
-- readable by a role with no policy on the tables under them. Set explicitly on
-- every one, in one place, because a default is a bad thing to rest a security
-- boundary on in either direction: written down, it is a decision; left off, it
-- is whatever the next Postgres release makes it.
do $$
declare
  v text;
begin
  foreach v in array array[
      'inspection_chart_visit',
      'inspection_chart_power', 'inspection_chart_radio', 'inspection_chart_gas',
      'inspection_chart_water_level', 'inspection_chart_data',
      'inspection_chart_fade_margin'] loop
    execute pg_catalog.format('alter view meganet.%I set (security_invoker = false)', v);
  end loop;
end
$$;

comment on view meganet.inspection_chart_power is
  'The numeric power readings of a live visit, and nothing else — no comments column, no LED colours, no weather note (0023).';
comment on view meganet.inspection_chart_radio is
  'The numeric radio readings of a live visit: transmitter, antenna, SWR (0023).';
comment on view meganet.inspection_chart_gas is
  'The numeric gas readings of a live visit: cylinder, feed, bubble rate, consumption (0023).';
comment on view meganet.inspection_chart_water_level is
  'The one numeric water-level reading a visit records per visit. `transmitter_range` is text and is not here — 0014''s projection excludes it for the same reason (0023).';
comment on view meganet.inspection_chart_data is
  'The numeric arrival/departure readings of a live visit, with the phase that says which (0023).';
comment on view meganet.inspection_chart_fade_margin is
  'The PATH MARGIN passes of a live visit, with the phase. Several rows per visit; the caller folds them with max (0023).';

-- ─────────────────────────────────────────────────────────────────────────────
-- §3. Who may read them
-- ─────────────────────────────────────────────────────────────────────────────
-- `anon` included, which is the point of the file. The base tables' grants are
-- untouched: nothing below mentions meganet.inspection or a section table.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on
      meganet.inspection_chart_visit,
      meganet.inspection_chart_power, meganet.inspection_chart_radio,
      meganet.inspection_chart_gas, meganet.inspection_chart_water_level,
      meganet.inspection_chart_data, meganet.inspection_chart_fade_margin
    to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4. Did it take, and is it still only numbers
-- ─────────────────────────────────────────────────────────────────────────────
-- Two checks, and the second is the one that matters. The first says the chart
-- will have something to draw; the second says nothing a person wrote can leave
-- through these views — re-run this file after any change to 0009's tables and
-- it will say so if a text column has found its way in.
--
-- tools/check_inspections.sql carries the same pair, plus "anon may still read
-- no record table". Both places on purpose: this one catches the mistake while
-- it is being made, that one catches it when a *later* migration makes it.

do $$
declare
  missing text;
  leaked  text;
begin
  -- 1 · Every field the chart may plot has a column in the matching view.
  --     Driven by meganet.measurement_field, the same table the picker and
  --     0014's projection read, so a field added to the vocabulary without a
  --     column here is loud rather than quietly unplottable for everybody.
  select string_agg(format('%s.%s', f.home_table, f.home_column), ', ' order by f.key)
    into missing
    from meganet.measurement_field f
   where f.home_table in ('inspection_power', 'inspection_radio', 'inspection_gas',
                          'inspection_water_level', 'inspection_data',
                          'inspection_fade_margin')
     and f.home_column <> ''
     -- The two the app names as text rather than numbers, for the reason 0014's
     -- projection gives: `battery_test_raw` lands in comments and
     -- `analogue_range_m` in transmitter_range, and there is no number in
     -- either to draw.
     and f.home_column not in ('comments', 'transmitter_range')
     and not exists (
       select 1 from information_schema.columns c
        where c.table_schema = 'meganet'
          and c.table_name = replace(f.home_table, 'inspection_', 'inspection_chart_')
          and c.column_name = f.home_column);

  if missing is not null then
    raise exception '0023 did not take: plottable fields with no column in their chart view — %', missing;
  end if;

  -- 2 · Nothing a person typed can leave through one of these views. Every
  --     column is a number, a date, a uuid — or one of the four that are not,
  --     each named here and each a closed vocabulary or a published key:
  --
  --       station_id      the stations.json slug, public since 0002
  --       date_precision  'day' | 'month' | 'year'      (check constraint)
  --       origin          'form' | 'import'             (check constraint)
  --       phase           'initial' | 'final', 'original' | 'this_visit'  (ditto)
  select string_agg(format('%s.%s (%s)', c.table_name, c.column_name, c.data_type),
                    ', ' order by c.table_name, c.column_name)
    into leaked
    from information_schema.columns c
   where c.table_schema = 'meganet'
     and c.table_name = any (array[
           'inspection_chart_visit',
           'inspection_chart_power', 'inspection_chart_radio', 'inspection_chart_gas',
           'inspection_chart_water_level', 'inspection_chart_data',
           'inspection_chart_fade_margin'])
     and c.data_type not in ('numeric', 'integer', 'bigint', 'smallint',
                             'double precision', 'real', 'date', 'uuid',
                             'timestamp with time zone')
     and c.column_name not in ('station_id', 'date_precision', 'origin', 'phase');

  if leaked is not null then
    raise exception '0023 is unsafe: a chart view carries a column that is not a number — %', leaked;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 22 → 23 in the same commit as this file.
-- Until this migration is applied the app says "Connected · schema mismatch" on
-- the Data source panel and the station card's chart says it could not read the
-- inspections — which is the correct pair of complaints, and the reason the
-- version is checked at all.

insert into meganet.app_meta (key, value)
values ('schema_version', '23')
on conflict (key) do update set value = excluded.value;
