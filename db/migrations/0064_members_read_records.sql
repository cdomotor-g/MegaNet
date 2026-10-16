-- 0064_members_read_records.sql — Approved accounts read the inspection and
-- maintenance records, so the people who maintain the sites see what the
-- records hold: gate combinations, padlock and logger codes, key numbers,
-- access and safety notes. Editors still write them; anonymous still sees none.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0064_members_read_records.sql
--
-- Why this file exists
-- ────────────────────
-- 0009 made every record table readable by editors and nobody else, when
-- editors were the only accounts there were. 0062 opened accounts: anybody may
-- make one, a Bureau address is approved at once, and an administrator approves
-- anybody else — a council's or a contractor's field crew among them — as a
-- *member*, who sees the field photos but is not on the editors list. Those are
-- the people who go to the sites, and the site's codes are in the records'
-- words (a remark, a block's ID line or notes, a derived event's quote), so
-- they cannot read one without the other.
--
--   * Read: every table below, `(select meganet.is_member())` — every editor is
--     a member, so nobody who could read a record loses it. The policies keep
--     their tables and verbs; they are renamed `*_read_members` because a name
--     that says editors would now be wrong.
--   * Write: untouched. Every insert, update and delete policy, and every save_*
--     and delete_* function, still asks meganet.is_editor().
--   * Anonymous: untouched — nothing here is granted to anon, and the public
--     inspection_chart_* views (0023) still carry numbers and nothing else.
--
-- The `inspections` Storage bucket — the files these records attach — follows
-- in tools/storage_bucket.sql (`inspections_read_members`), applied by hand like
-- the rest of that file because Storage's schema is not ours.
--
-- Level surveys, site features, receptions, the station history and the raw
-- readings stay editors-only: nobody asked to widen them, and none of them is
-- where a site's codes are kept.

do $$
declare
  t text;
  tables constant text[] := array[
    -- 0009: a visit and its sections, and the Council form.
    'inspection', 'inspection_admin', 'inspection_calibration', 'inspection_data',
    'inspection_data_quality', 'inspection_data_value', 'inspection_fade_margin',
    'inspection_gas', 'inspection_power', 'inspection_radio', 'inspection_rain_gauge',
    'inspection_serial', 'inspection_water_level',
    'maintenance_activity', 'maintenance_asset', 'maintenance_data_quality',
    -- 0009/0010: the index of the files both forms attach.
    'attachment',
    -- 0014, 0016: the historical record and what was mined from its remarks.
    'inspection_block', 'inspection_block_fact', 'inspection_measurement',
    'inspection_reject', 'inspection_event'];
begin
  foreach t in array tables loop
    if exists (select 1 from pg_catalog.pg_policies
                where schemaname = 'meganet' and tablename = t and policyname = t || '_read_editors') then
      execute pg_catalog.format('alter policy %I on meganet.%I using ((select meganet.is_member()))',
                                t || '_read_editors', t);
      execute pg_catalog.format('alter policy %I on meganet.%I rename to %I',
                                t || '_read_editors', t, t || '_read_members');
    elsif exists (select 1 from pg_catalog.pg_policies
                   where schemaname = 'meganet' and tablename = t and policyname = t || '_read_members') then
      execute pg_catalog.format('alter policy %I on meganet.%I using ((select meganet.is_member()))',
                                t || '_read_members', t);
    else
      raise exception '0064: meganet.% has neither %_read_editors nor %_read_members', t, t, t;
    end if;
  end loop;
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
declare
  n integer;
  tables constant text[] := array[
    'inspection', 'inspection_admin', 'inspection_calibration', 'inspection_data',
    'inspection_data_quality', 'inspection_data_value', 'inspection_fade_margin',
    'inspection_gas', 'inspection_power', 'inspection_radio', 'inspection_rain_gauge',
    'inspection_serial', 'inspection_water_level', 'maintenance_activity',
    'maintenance_asset', 'maintenance_data_quality', 'attachment',
    'inspection_block', 'inspection_block_fact', 'inspection_measurement',
    'inspection_reject', 'inspection_event'];
begin
  select count(*) into n from pg_catalog.pg_policies
   where schemaname = 'meganet' and policyname like '%\_read\_members' and cmd = 'SELECT'
     and qual like '%is_member()%'
     and tablename = any (tables);
  if n <> 22 then
    raise exception '0064 did not take: % of 22 record tables read by members', n;
  end if;

  -- Nothing that writes may have been widened with it.
  if exists (select 1 from pg_catalog.pg_policies
              where schemaname = 'meganet' and tablename = any (tables) and cmd <> 'SELECT'
                and (coalesce(qual, '') like '%is_member()%' or coalesce(with_check, '') like '%is_member()%')) then
    raise exception '0064 did not take: a write policy asks is_member()';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and pg_catalog.has_table_privilege('anon', 'meganet.inspection', 'select') then
    raise exception '0064 did not take: anon can select meganet.inspection';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 64 in the same commit. Applying it out of
-- order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '64')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
