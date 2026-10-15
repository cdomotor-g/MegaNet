-- 0063_no_landholder_contacts.sql — Flood-Net holds no landholder contact
-- details. The Council form's Landowner block goes, the archive's `Property
-- Owner:` line goes, and the imported rows whose text named a landholder or
-- carried a phone number or an email are rewritten to the scrubbed text.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0063_no_landholder_contacts.sql
--
-- Why this file exists
-- ────────────────────
-- Who owns the land under a station, and how to reach them, is the Bureau's to
-- hold, and its contractors' and the councils' who maintain the sites — not
-- this app's. Holding it put names, home phone numbers and email addresses of
-- private people in a database whose key is published, behind nothing but an
-- editors-only policy, and in a public repository besides. So none of it is
-- kept, rather than kept carefully:
--
--   1. maintenance_activity  loses landowner_contact_name, _email, _phone and
--                            landowner_comments (0009). The live database had no
--                            maintenance forms, so nothing typed is lost; the
--                            form (maintenance.js) no longer draws the block,
--                            and save_maintenance_activity() is redefined
--                            without the four columns, so an old copy of the
--                            app still open somewhere that sends them has them
--                            ignored rather than refused.
--   2. inspection_block      loses property_owner (0014) — the line above each
--                            station block in `QLD All Site Inspections.xlsx`,
--                            311 of 1,093 blocks naming a landholder and their
--                            numbers. inspection_history, the one view that
--                            read it, is dropped and recreated without it (a
--                            view cannot lose a column in place); its grant to
--                            authenticated is re-made the way 0014 made it.
--   3. The imported rows     the workbook itself was scrubbed before this
--                            commit (owner lines blanked, every phone number and
--                            email redacted, landholders' names in remarks
--                            replaced) and data/inspections/ re-derived from it.
--                            A fresh database loaded from those files is clean
--                            already; §3 brings a database loaded from the old
--                            files to the same text, row by row, by key. Each
--                            statement sets a value to what the new files say,
--                            so re-running it, or running it before the load
--                            (where it touches nothing), is harmless.
--
-- The telephone-telemetry `Phone No.` values on the blocks' ID lines go too.
-- They are a station's line rather than a person's, mostly — but at least one
-- was the landholder's own mobile, nothing tells the rest apart, and the
-- Bureau holds the real list.
--
-- tools/ingest/extract.py now refuses a workbook that brings a phone number or
-- an email back (spec: docs/inspection-workbook-parse-spec.md), so a refreshed
-- archive cannot quietly restore what this removes.

-- ── 1. The Council form's Landowner block ────────────────────────────────────
-- Redefined before the drop for readability; plpgsql resolves columns when it
-- runs, not when it is created, so the order inside the transaction is free.

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
      council_comments,
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
  'Insert or update one Council Maintenance Tasks record and its panels, in one transaction. Same stale-write contract as meganet.save_station(). Landowner keys in the document are ignored: Flood-Net holds no landholder contact details (0063).';

alter table meganet.maintenance_activity drop column if exists landowner_contact_name;
alter table meganet.maintenance_activity drop column if exists landowner_contact_email;
alter table meganet.maintenance_activity drop column if exists landowner_contact_phone;
alter table meganet.maintenance_activity drop column if exists landowner_comments;

comment on table meganet.maintenance_activity is
  'The Council Site Maintenance Tasks form. Holds the council''s contact details and site-access notes, which is why nothing here is readable with the anon key. No landholder contact details: the paper sheet''s Landowner block is left off on purpose (0063).';

-- ── 2. The archive's Property Owner line ─────────────────────────────────────
-- inspection_history is 0014's, word for word, less b.property_owner.

drop view if exists meganet.inspection_history;

alter table meganet.inspection_block drop column if exists property_owner;

create view meganet.inspection_history
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

revoke all on meganet.inspection_history from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  revoke all on meganet.inspection_history from anon;
  grant select on meganet.inspection_history to authenticated;
  notify pgrst, 'reload schema';
end
$$;

-- ── 3. The imported rows, brought to the scrubbed text ───────────────────────
-- Generated from the difference between data/inspections/ before and after the
-- workbook was scrubbed. Keyed on what load.py keys them on: a block's ref, a
-- fact's (block, kind, ord), a visit's uuid5 id with origin = 'import' (a visit
-- typed into the app is never touched), a derived event's id.

-- Blocks: the ID line, the notes and the annotation rows (78).
update meganet.inspection_block set annotations = '[{"row": 427, "text": "Site access call energyq (scada and telecommunications systems) STOC [phone removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Brisbane!:392';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7113 | Batt = 7016 | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Brisbane!:1464';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 305"}'::jsonb where ref = 'qld-all-site-inspections:Border!:303';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 344"}'::jsonb where ref = 'qld-all-site-inspections:Border!:342';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 388"}'::jsonb where ref = 'qld-all-site-inspections:Border!:386';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7726 | Batt = 7762 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Border!:426';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7727 | Batt = 7763 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Border!:466';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 510"}'::jsonb where ref = 'qld-all-site-inspections:Border!:508';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 547"}'::jsonb where ref = 'qld-all-site-inspections:Border!:545';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7745 | Batt = 7766 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Border!:581';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7749 | Batt = 7748 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Border!:622';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7747 | Batt = 7746 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Border!:665';
update meganet.inspection_block set notes = '{"group_row_note": "Orifice RL = 0.544m GH", "phone_no": "[phone removed]", "stray_point_row_above_header": "row 868"}'::jsonb where ref = 'qld-all-site-inspections:Border!:866';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 1000"}'::jsonb where ref = 'qld-all-site-inspections:Border!:998';
update meganet.inspection_block set notes = '{"group_row_note": "Orifice RL = 0.760m GH from 13/7/2017", "phone_no": "[phone removed]", "stray_point_row_above_header": "row 1024"}'::jsonb where ref = 'qld-all-site-inspections:Border!:1022';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7728 | Batt = 7768 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Condamine!:1652';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]", "stray_point_row_above_header": "row 1698"}'::jsonb where ref = 'qld-all-site-inspections:Condamine!:1696';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7473 | Batt = 7474 | Phone No. [phone removed] (Old L/L [phone removed])' where ref = 'qld-all-site-inspections:Fitzroy!:2114';
update meganet.inspection_block set notes = '{"group_row_note": "NextG IP - 134.178.54.22", "phone_no": "[phone removed] ??"}'::jsonb where ref = 'qld-all-site-inspections:Fitzroy!:2335';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Fitzroy!:2498';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Fitzroy!:2521';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Fitzroy!:2547';
update meganet.inspection_block set notes = '{"group_row_note": "[phone removed]", "phone_no": "."}'::jsonb where ref = 'qld-all-site-inspections:Mary!:845';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = | 7106 | Batt = | 7834 | Phone No. | [phone removed]' where ref = 'qld-all-site-inspections:Mary!:883';
update meganet.inspection_block set annotations = '[{"row": 100, "text": "Property Caretaker: [removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Logan!:56';
update meganet.inspection_block set annotations = '[{"row": 609, "text": "General Manager ([name removed]) Palen Creek Correctional Centre Phone: [phone removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Logan!:570';
update meganet.inspection_block set annotations = '[{"row": 910, "text": "Nambour Base Station ALERT Phone No: [phone removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Maroochy!:869';
update meganet.inspection_block set annotations = '[{"row": 896, "text": "Wharf Owner - [removed] ***NB: contact before entering***"}]'::jsonb where ref = 'qld-all-site-inspections:Nerang!:866';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = | 7618 | Batt = | 7619 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Warrego!:839';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7283 | Rv = 7282 | Batt = 7787 | Phone No: [phone removed] | Orifice RL = 0.20m GHt(after 8/2010)' where ref = 'qld-all-site-inspections:Warrego!:881';
update meganet.inspection_block set annotations = '[{"row": 627, "text": "Warwick ALERT Base Station Phone No. [phone removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Warwick!:574';
update meganet.inspection_block set annotations = '[{"row": 449, "text": "Don River ALERT Base Station: Phone No: [phone removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Don!:397';
update meganet.inspection_block set annotations = '[{"row": 274, "text": "Contact: [removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Tully!:235';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 5113 | Rv = 5114 | Batt = 5115 | Bridge Deck = 0.00m. Assumed | TM Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Mulgrave&Russell!:113';
update meganet.inspection_block set ids_raw = 'ID''s | Rv = 7246 | Batt = 7912 | Phone No. [phone removed] | Orifice Level = -0.003m. gauge height' where ref = 'qld-all-site-inspections:Closed stations:2';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7395 | Batt = 7913 | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:19';
update meganet.inspection_block set ids_raw = 'ID''s | Rv = 7244 | Batt = 7907 | Phone No. [phone removed] | Orifice Level = 0.655m GH.' where ref = 'qld-all-site-inspections:Closed stations:36';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7086 | Batt = 7909 | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:52';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7113 | Batt = 7914 | Phone No. [phone removed] | ( Floor of hut RL = 8.57m. Gauge height datum)' where ref = 'qld-all-site-inspections:Closed stations:69';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7111 | Batt = 7911 | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:86';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb, annotations = '[{"row": 129, "text": "General Manager ([name removed]) Palen Creek Correctional Centre Phone: [phone removed]"}]'::jsonb where ref = 'qld-all-site-inspections:Closed stations:114';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7239 | Batt = 7910 | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:130';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7001 | Batt = 7482 | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:150';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:186';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:213';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:244';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed] old L/L [phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:278';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:308';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:339';
update meganet.inspection_block set notes = '{"cbm_note": "039338 < Still open as Old Range Rd Alert", "group_row_note": "NextG IP - Old Phone No. [phone removed]; was L/L [phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:372';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:405';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:422';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:441';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:457';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:470';
update meganet.inspection_block set notes = '{"absorbed_value_in_header": "River Calibration (metres): 1", "group_row_note": "Orifice Level =", "phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:488';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = | Batt = | Phone No. [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:499';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7640 | Batt = 7655 | Phone No: [phone removed] (L/L was [phone removed])' where ref = 'qld-all-site-inspections:Closed stations:512';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7652 | Batt = 7651 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:545';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7647 | Batt = 7646 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:577';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7654 | Batt = 7653 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:609';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7859 | Rv = 7860 | Batt = 7861 | Phone No: [phone removed] | Orifice Level = 0.370m GH' where ref = 'qld-all-site-inspections:Closed stations:642';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7856 | Rv = 7857 | Batt = 7858 | Phone No: [phone removed] | Orifice Level = 0.500m GH' where ref = 'qld-all-site-inspections:Closed stations:663';
update meganet.inspection_block set ids_raw = 'ID''s | Rv = 7132 | Batt = 7915 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:683';
update meganet.inspection_block set notes = '{"absorbed_value_in_header": "River Calibration (metres): 1", "group_row_note": "Security Code = 20101", "phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:704';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7692 | Rv = 7693 | Batt = 7696 | Phone No: [phone removed] | Orifice RL = 0.000m (Assumed)' where ref = 'qld-all-site-inspections:Closed stations:735';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7143 | Rv = 7142 | Batt = 7786 | Phone No: [phone removed] | Orifice RL = 0.390m GH' where ref = 'qld-all-site-inspections:Closed stations:767';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7281 | Rv = 7280 | Batt = 7792 | Phone No: [phone removed] (was L/L [phone removed]) | Orifice RL = 1.12m GH' where ref = 'qld-all-site-inspections:Closed stations:781';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7223 | Rv = 7222 | Batt = 7791 | Phone No: [phone removed] | Orifice RL = 0.60m GH(after Feb 2010)' where ref = 'qld-all-site-inspections:Closed stations:815';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7150 | Rv = 7151 | Batt = 7790 | Phone No: [phone removed] | Orifice RL = - 0.390m GH' where ref = 'qld-all-site-inspections:Closed stations:848';
update meganet.inspection_block set notes = '{"phone_no": "[phone removed] as at 7/7/15"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:875';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = | Rv = 7744 | Batt = 7742 | Phone No: [phone removed] | Orifice RL = 298.080m AHD (-1.085m GH)' where ref = 'qld-all-site-inspections:Closed stations:962';
update meganet.inspection_block set notes = '{"group_row_note": "Orifice RL = 0.859m GH", "phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:990';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7754 | Rv = 7755 | Phone No: [phone removed] | Orifice RL = 1.163m GH (273.663m AHD)' where ref = 'qld-all-site-inspections:Closed stations:1011';
update meganet.inspection_block set notes = '{"absorbed_value_in_header": "River Calibration (metres): 1", "group_row_note": "Logger Security code: 250", "phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:1045';
update meganet.inspection_block set notes = '{"absorbed_value_in_header": "River Calibration (metres): 1", "group_row_note": "Logger Security code: 250", "phone_no": "[phone removed]"}'::jsonb where ref = 'qld-all-site-inspections:Closed stations:1064';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = 7223 | Rv = 7222 | Batt = 7791 | Phone No: [phone removed] | Orifice RL = 0.60m GH(after Feb 2010)' where ref = 'qld-all-site-inspections:Closed stations:1082';
update meganet.inspection_block set ids_raw = 'ID''s | Rn = | 7622 | Batt = | 7623 | Phone No: [phone removed]' where ref = 'qld-all-site-inspections:Closed stations:1115';

-- The ID line, split: the telephone number fact (36).
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Brisbane!:1464' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Border!:426' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Border!:466' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Border!:581' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Border!:622' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Border!:665' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Condamine!:1652' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed] (Old L/L [phone removed])', value_num = null where block_ref = 'qld-all-site-inspections:Fitzroy!:2114' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Warrego!:839' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Warrego!:881' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Mulgrave&Russell!:113' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:2' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:19' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:36' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:52' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:69' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:86' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:130' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:150' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:499' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed] (L/L was [phone removed])', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:512' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:545' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:577' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:609' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:642' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:663' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:683' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:735' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:767' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed] (was L/L [phone removed])', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:781' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:815' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:848' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:962' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:1011' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:1082' and fact_key = 'phone_no_raw' and ord = 1;
update meganet.inspection_block_fact set value_raw = '[phone removed]', value_num = null where block_ref = 'qld-all-site-inspections:Closed stations:1115' and fact_key = 'phone_no_raw' and ord = 1;

-- Visits: remarks that named a landholder or carried a number (16).
update meganet.inspection set remarks = 'TBRG blocked on arrival - cleared. Already has bird guard. Battery replaced due to age. Rope replaced. Unable to access "[name removed]" property at lower gate. Met the owner of neighbouring property. OK to drive to the nearest point and walk over. Call to arrange gate to be unlocked.' where id = 'f2915024-46cd-52df-a6c3-434c2a001e08' and origin = 'import';
update meganet.inspection set remarks = 'boards overgrown and falling over. [name removed] manager at Bengalla mentioned reading higher last Feb. Mentioned offset of .325 to council.Battery due next visit' where id = '2407129c-aaf3-57be-bb98-bb4c387b8cfe' and origin = 'import';
update meganet.inspection set remarks = 'New owner [name removed] #[phone removed] "Glenburn" New oner approx May.' where id = '282d549f-136a-5a6e-98bd-1ddadf77041f' and origin = 'import';
update meganet.inspection set remarks = 'Unable to access via alternate track.  Met [name removed] from Green Valley - quote prepared for Council to push through an old but more direct track - CHRC to invoice BoM; CHRC and/or BoM staff to service station immediately after track cleared.  [name removed] has extensive knowledge of the Billaboo property and believes the current site is the best possible for path to both Upper Retreat and Mt Mayde.' where id = '266d3ead-f80b-5ed0-ab3f-fcc737dba234' and origin = 'import';
update meganet.inspection set remarks = '[name removed] [phone removed]' where id = '58de3e72-8319-589e-a77a-d140d4d255e1' and origin = 'import';
update meganet.inspection set remarks = '[name removed] [phone removed] - [email removed], [name removed] [phone removed]' where id = '9f7e8b9a-8e42-5775-8f0e-7c8aa6176166' and origin = 'import';
update meganet.inspection set remarks = 'Talked to [name removed] - Mobile [phone removed] Email: [email removed] - please send instructons to find rainfall. Same situation re: keypad works, PC200 doesn''t.' where id = '0d674894-a937-593f-be52-2f93b6c2f787' and origin = 'import';
update meganet.inspection set remarks = 'Update contacts to [name removed] only. Battery replaced due to age. Monitor new battery - solar results low presumably due to heavy cloud.' where id = 'b8b20ae3-a548-5b62-9f1d-5b215268dbcc' and origin = 'import';
update meganet.inspection set remarks = 'New Landowner [name removed] - [phone removed], [name removed] - [phone removed]. Adjusted condor switch from 260 to 380 kick in. Battery replaced due to age' where id = 'd993251e-0597-563f-b9c3-1e211e919bf0' and origin = 'import';
update meganet.inspection set remarks = 'Additional porperty owner contact = [phone removed]' where id = '1bfc27a0-6d78-594c-b4f7-6e10226982f4' and origin = 'import';
update meganet.inspection set remarks = '[name removed] [phone removed] - [email removed], send rainobs, still wants alert data, Removed Mercoid Switch & TM Logger (whole box). Swapped Battery.' where id = '04550c92-2dcd-58a2-ac5d-20a48ad20297' and origin = 'import';
update meganet.inspection set remarks = 'Antenna replaced. Old cannister 1995? and TBRG.[name removed] prop. owner will clear nearby wattle saplings' where id = '8362d621-0558-5489-a8c3-33ef3c4dfbdf' and origin = 'import';
update meganet.inspection set remarks = 'Level 2 comms. cupboard. Contact [name removed] [phone removed]' where id = 'e64fa5a5-8481-529a-b305-af12d1bdfdb5' and origin = 'import';
update meganet.inspection set remarks = 'TBRG starting to peel . Met with [name removed]-maintenance mgr. he is happy to clean gauge if need be' where id = 'caa9d212-f4f4-5330-a726-022ebbf08bb1' and origin = 'import';
update meganet.inspection set remarks = '[name removed] [phone removed]. 12V DC Mains Power supply' where id = 'bdaa5eee-6338-569c-bbdc-57a048b46879' and origin = 'import';
update meganet.inspection set remarks = 'Property owners [name removed] now live back on the property.' where id = '20daf231-a70a-53bc-bca7-dd494d34e201' and origin = 'import';

-- Derived events: the one quote that named a landholder's property.
update meganet.inspection_event set quote = 'Unable to access "[name removed]" property at lower gate' where id = '2a3f9544-1c57-523b-beb8-0e70f2470c29';

-- ── 4. Did it take ───────────────────────────────────────────────────────────
-- A phone number (spaced, or after a label) or an email left anywhere the
-- import wrote text is a failed migration, not a warning. Typed visits are not
-- checked: what an editor writes in a remark is theirs, and a typed number must
-- not be able to block a deploy.

do $$
declare
  re  constant text := '[[:alnum:]._%+-]+@[[:alnum:]-]+\.[[:alpha:]]{2,}'
                    || '|(^|[^0-9.])0[2378][ -]+[0-9]{4}[ -]+[0-9]{4}([^0-9]|$)'
                    || '|(^|[^0-9.])04[0-9]{2}[ -]+[0-9]{3}[ -]+[0-9]{3}([^0-9]|$)'
                    || '|(phone|mob|mobile)[^0-9a-z]{0,12}[0-9]{4}';
  n   bigint;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'meganet'
                and ((table_name = 'maintenance_activity' and column_name like 'landowner%')
                  or (table_name = 'inspection_block' and column_name = 'property_owner'))) then
    raise exception '0063 did not take: a landholder contact column is still there';
  end if;

  select (select count(*) from meganet.inspection_block
           where ids_raw ~* re or notes::text ~* re or annotations::text ~* re or comments::text ~* re)
       + (select count(*) from meganet.inspection_block_fact where value_raw ~* re)
       + (select count(*) from meganet.inspection where origin = 'import' and remarks ~* re)
       + (select count(*) from meganet.inspection_event where quote ~* re)
    into n;
  if n > 0 then
    raise exception '0063 did not take: % imported rows still carry a phone number or an email', n
      using hint = 'load data/inspections/ as this commit left it (tools/ingest/load.py), then re-run';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 63 in the same commit as this file. The
-- guard means applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '63')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
