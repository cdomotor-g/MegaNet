-- 0065_alert2_plan_shared.sql — The ALERT2 Transition Plan's two shared
-- stores, for administrators and nobody else: what each repeater site needs
-- (its site condition), one answer per site that every administrator sees, and
-- saved scenarios — private to the administrator who saved one until they
-- share it, when every administrator sees it.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0065_alert2_plan_shared.sql
--
-- Why this file exists
-- ────────────────────
-- The plan (alert2-plan.js) is worked from the register under a card of
-- sliders. Two things on it were kept in the browser that made them, and the
-- owner asked for both to be kept here instead:
--
--   * A site condition — fit-out only, a retrofit, or the structure rebuilt —
--     is what somebody knows of a repeater site. It is a fact about the site,
--     not a lever, so there is one answer per site and every administrator
--     plans with it. Nothing else holds it: the inspection records say what a
--     visit found, not what the transition must do.
--   * A scenario is the card as somebody set it — the scope, the crews, the
--     rates, the catchments ticked and their order — with a name. It starts
--     private, so an administrator can play with one without anybody seeing,
--     and is shared when it is ready: every administrator sees it then, and
--     only its author may change or delete it (the others can load it and save
--     their own copy).
--
-- Who
-- ───
--   * Read: a2plan_read() — security definer, administrators only — answers
--     the site conditions and the scenarios the caller may see: their own, and
--     every shared one, each with who set it. The tables' select policies say
--     the same for a direct read.
--   * Write: a2plan_site_set(), a2plan_scenario_save() and
--     a2plan_scenario_delete(), administrators only; a scenario only by its
--     author. No browser role holds a write grant on either table.
--   * Anonymous and members: nothing. The tab is for administrators, and
--     nothing here is granted to anon.
--
-- Shared means "every administrator" today. The owner expects groups later —
-- one company planning on its own and sharing with its own people. That is a
-- group id on the scenario and a membership test in the one select policy and
-- a2plan_read(); nothing here assumes it will never come.

-- ── 1. Site conditions ───────────────────────────────────────────────────────

create table if not exists meganet.a2plan_site (
  station_id  text        primary key references meganet.station (id) on delete cascade,
  condition   text        not null,
  updated_by  uuid        references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  constraint a2plan_site_condition check (condition in ('fit', 'retrofit', 'rebuild'))
);

comment on table meganet.a2plan_site is
  'What a repeater site needs before it carries ALERT2, as an administrator knows it (0065): fit (a fit-out only), retrofit (power, antenna, enclosure, earthing, access) or rebuild (the structure). One row a site; no row is "not assessed". Read through a2plan_read(), written through a2plan_site_set().';

drop trigger if exists a2plan_site_touch_updated_at on meganet.a2plan_site;
create trigger a2plan_site_touch_updated_at
  before update on meganet.a2plan_site
  for each row execute function meganet.touch_updated_at();

alter table meganet.a2plan_site enable row level security;

drop policy if exists a2plan_site_read_admins on meganet.a2plan_site;
create policy a2plan_site_read_admins on meganet.a2plan_site
  for select to authenticated
  using ((select meganet.is_admin()));

-- ── 2. Scenarios ─────────────────────────────────────────────────────────────

create table if not exists meganet.a2plan_scenario (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  name        text        not null,
  notes       text,
  shared      boolean     not null default false,
  settings    jsonb       not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint a2plan_scenario_name check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 80
                                         and name !~ '[[:cntrl:]]'),
  constraint a2plan_scenario_notes check (notes is null or pg_catalog.length(notes) <= 2000),
  constraint a2plan_scenario_settings check (pg_catalog.jsonb_typeof(settings) = 'object'
                                             and pg_catalog.octet_length(settings::text) <= 65536)
);

create index if not exists a2plan_scenario_owner on meganet.a2plan_scenario (owner_id);

comment on table meganet.a2plan_scenario is
  'A saved ALERT2 Transition Plan scenario (0065): the card''s settings as an object the app checks again on load, a name and notes. Private to owner_id until shared, then seen by every administrator; only its owner changes or deletes it. Read through a2plan_read(), written through a2plan_scenario_save() and a2plan_scenario_delete().';

drop trigger if exists a2plan_scenario_touch_updated_at on meganet.a2plan_scenario;
create trigger a2plan_scenario_touch_updated_at
  before update on meganet.a2plan_scenario
  for each row execute function meganet.touch_updated_at();

alter table meganet.a2plan_scenario enable row level security;

drop policy if exists a2plan_scenario_read_own_or_shared on meganet.a2plan_scenario;
create policy a2plan_scenario_read_own_or_shared on meganet.a2plan_scenario
  for select to authenticated
  using ((select meganet.is_admin()) and (owner_id = (select auth.uid()) or shared));

-- ── 3. Reading ───────────────────────────────────────────────────────────────
-- One call when the tab opens: every site condition, and every scenario the
-- caller may see, newest first. "by" is the display name, else the address,
-- of whoever set it — administrators see each other's.

create or replace function meganet.a2plan_read()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_admin() then
    raise exception 'the ALERT2 Transition Plan is for administrators' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'sites', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'station_id', s.station_id, 'condition', s.condition, 'updated_at', s.updated_at,
               'by', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email))
             order by s.station_id)
        from meganet.a2plan_site s
        left join meganet.app_user u on u.id = s.updated_by), '[]'::jsonb),
    'scenarios', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', c.id, 'name', c.name, 'notes', c.notes, 'shared', c.shared,
               'mine', c.owner_id = auth.uid(), 'by', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email),
               'settings', c.settings, 'created_at', c.created_at, 'updated_at', c.updated_at)
             order by c.updated_at desc, c.id)
        from meganet.a2plan_scenario c
        left join meganet.app_user u on u.id = c.owner_id
       where c.owner_id = auth.uid() or c.shared), '[]'::jsonb));
end;
$$;

comment on function meganet.a2plan_read() is
  'The ALERT2 Transition Plan''s shared state for an administrator (0065): {sites: [{station_id, condition, updated_at, by}], scenarios: [{id, name, notes, shared, mine, by, settings, created_at, updated_at}]} — every site condition, and the caller''s own scenarios and every shared one.';

-- ── 4. Writing ───────────────────────────────────────────────────────────────

-- A site's condition, set or — with null or '' — cleared back to "not
-- assessed". Answers the row as a2plan_read() gives it.
create or replace function meganet.a2plan_site_set(p_station_id text, p_condition text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator may say what a site needs' using errcode = '42501';
  end if;
  if p_station_id is null or not exists (select 1 from meganet.station st where st.id = p_station_id) then
    raise exception 'no station %', coalesce(p_station_id, '(none)') using errcode = '22023';
  end if;
  if p_condition is null or p_condition = '' then
    delete from meganet.a2plan_site where station_id = p_station_id;
    return pg_catalog.jsonb_build_object('station_id', p_station_id, 'condition', null);
  end if;
  if p_condition not in ('fit', 'retrofit', 'rebuild') then
    raise exception 'a site condition is fit, retrofit or rebuild' using errcode = '22023';
  end if;
  insert into meganet.a2plan_site (station_id, condition, updated_by)
  values (p_station_id, p_condition, auth.uid())
  on conflict (station_id) do update
    set condition = excluded.condition, updated_by = excluded.updated_by;
  select pg_catalog.jsonb_build_object(
           'station_id', s.station_id, 'condition', s.condition, 'updated_at', s.updated_at,
           'by', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email))
    into v
    from meganet.a2plan_site s
    left join meganet.app_user u on u.id = s.updated_by
   where s.station_id = p_station_id;
  return v;
end;
$$;

comment on function meganet.a2plan_site_set(text, text) is
  'Set what a repeater site needs — fit, retrofit or rebuild — or clear it with null or '''' (0065). Administrators only; every administrator sees the same answer.';

-- A scenario saved: a new one (p_id null) belongs to the caller; an existing
-- one is changed only by its author, and a null argument leaves its field as
-- it is — so sharing, renaming and saving the card again are one door.
create or replace function meganet.a2plan_scenario_save(
  p_id uuid, p_name text, p_notes text, p_shared boolean, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.a2plan_scenario;
  v_by  text;
begin
  if auth.uid() is null or not meganet.is_admin() then
    raise exception 'only an administrator, signed in, may save a scenario' using errcode = '42501';
  end if;
  if p_name is not null and (pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 80 or p_name ~ '[[:cntrl:]]') then
    raise exception 'a scenario''s name is 1–80 characters' using errcode = '22023';
  end if;
  if p_notes is not null and pg_catalog.length(p_notes) > 2000 then
    raise exception 'a scenario''s notes are at most 2,000 characters' using errcode = '22023';
  end if;
  if p_settings is not null and (pg_catalog.jsonb_typeof(p_settings) <> 'object'
                                 or pg_catalog.octet_length(p_settings::text) > 65536) then
    raise exception 'a scenario''s settings are an object of at most 64 KB' using errcode = '22023';
  end if;

  if p_id is null then
    if p_name is null or p_settings is null then
      raise exception 'a new scenario needs a name and its settings' using errcode = '22023';
    end if;
    if (select count(*) from meganet.a2plan_scenario c where c.owner_id = auth.uid()) >= 200 then
      raise exception 'at most 200 scenarios each — delete one first' using errcode = '22023';
    end if;
    insert into meganet.a2plan_scenario (owner_id, name, notes, shared, settings)
    values (auth.uid(), pg_catalog.btrim(p_name), nullif(pg_catalog.btrim(p_notes), ''), coalesce(p_shared, false), p_settings)
    returning * into v_row;
  else
    update meganet.a2plan_scenario c
       set name     = coalesce(pg_catalog.btrim(p_name), c.name),
           notes    = case when p_notes is null then c.notes else nullif(pg_catalog.btrim(p_notes), '') end,
           shared   = coalesce(p_shared, c.shared),
           settings = coalesce(p_settings, c.settings)
     where c.id = p_id and c.owner_id = auth.uid()
    returning * into v_row;
    if not found then
      if exists (select 1 from meganet.a2plan_scenario c where c.id = p_id and (c.shared or c.owner_id = auth.uid())) then
        raise exception 'only the administrator who saved a scenario may change it — save your own copy' using errcode = '42501';
      end if;
      raise exception 'no such scenario' using errcode = 'P0002';
    end if;
  end if;

  select coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email) into v_by
    from meganet.app_user u where u.id = v_row.owner_id;
  return pg_catalog.jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'notes', v_row.notes, 'shared', v_row.shared, 'mine', true, 'by', v_by,
    'settings', v_row.settings, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at);
end;
$$;

comment on function meganet.a2plan_scenario_save(uuid, text, text, boolean, jsonb) is
  'Save an ALERT2 plan scenario (0065): p_id null makes a new one, private unless p_shared; otherwise its author changes it, a null argument leaving that field. Administrators only.';

-- A scenario removed by its author. Removing one that is not there answers
-- false rather than refusing, so a second press is harmless.
create or replace function meganet.a2plan_scenario_delete(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if auth.uid() is null or not meganet.is_admin() then
    raise exception 'only an administrator, signed in, may remove a scenario' using errcode = '42501';
  end if;
  with gone as (
    delete from meganet.a2plan_scenario s
     where s.id = p_id and s.owner_id = auth.uid()
    returning 1)
  select count(*) into n from gone;
  if n > 0 then
    return true;
  end if;
  if exists (select 1 from meganet.a2plan_scenario s where s.id = p_id and s.shared) then
    raise exception 'only the administrator who saved a scenario may remove it' using errcode = '42501';
  end if;
  return false;
end;
$$;

comment on function meganet.a2plan_scenario_delete(uuid) is
  'Remove an ALERT2 plan scenario (0065), its author only; false when there was none to remove.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The four doors revoked from public in the same file (db/README.md) and
-- granted to the two roles a request can be; the tables readable by
-- authenticated (the policies decide which rows) and writable by nobody.

revoke all on function meganet.a2plan_read()                                          from public;
revoke all on function meganet.a2plan_site_set(text, text)                            from public;
revoke all on function meganet.a2plan_scenario_save(uuid, text, text, boolean, jsonb) from public;
revoke all on function meganet.a2plan_scenario_delete(uuid)                           from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.a2plan_site, meganet.a2plan_scenario from anon;
  revoke insert, update, delete, truncate on meganet.a2plan_site, meganet.a2plan_scenario from authenticated;
  grant select on meganet.a2plan_site, meganet.a2plan_scenario to authenticated;
  grant select, insert, update, delete on meganet.a2plan_site, meganet.a2plan_scenario to service_role;
  grant execute on function meganet.a2plan_read()                                          to authenticated, service_role;
  grant execute on function meganet.a2plan_site_set(text, text)                            to authenticated, service_role;
  grant execute on function meganet.a2plan_scenario_save(uuid, text, text, boolean, jsonb) to authenticated, service_role;
  grant execute on function meganet.a2plan_scenario_delete(uuid)                           to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['a2plan_site', 'a2plan_scenario'] loop
    if pg_catalog.to_regclass('meganet.' || t) is null then
      raise exception '0065 did not take: meganet.% is missing', t;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('meganet.' || t)) then
      raise exception '0065 did not take: RLS is off on meganet.%', t;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
      if pg_catalog.has_table_privilege('anon', 'meganet.' || t, 'select,insert,update,delete')
         or pg_catalog.has_table_privilege('authenticated', 'meganet.' || t, 'insert,update,delete') then
        raise exception '0065 did not take: a browser role can write, or anon read, meganet.%', t;
      end if;
    end if;
  end loop;
  foreach f in array array['meganet.a2plan_read()', 'meganet.a2plan_site_set(text, text)',
                           'meganet.a2plan_scenario_save(uuid, text, text, boolean, jsonb)',
                           'meganet.a2plan_scenario_delete(uuid)'] loop
    if pg_catalog.has_function_privilege('public', f, 'execute') then
      raise exception '0065 did not take: public may execute %', f;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and pg_catalog.has_function_privilege('anon', f, 'execute') then
      raise exception '0065 did not take: anon may execute %', f;
    end if;
  end loop;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 65 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '65')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
