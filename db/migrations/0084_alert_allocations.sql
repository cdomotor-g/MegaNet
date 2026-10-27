-- 0084_alert_allocations.sql — ALERT addresses set aside before any station
-- holds them: the Allocate card on the Pass Ranges tab (address-space.js).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0084_alert_allocations.sql
--
-- Why this file exists
-- ────────────────────
-- A legacy ALERT address is 13 bits — 1 to 8,191 — and the Bureau's hubs reuse
-- them: Brisbane's 6039 is a river gauge, Perth's is an orchard. Inside a hub
-- an address belongs to one station (the register has ten that break that,
-- each a station entered twice), and a new station under a repeater wants one
-- its pass ranges carry. Until now the only record of "this one is spoken for"
-- was a station already holding it, so two people planning two sites the same
-- week could each pick the same free address and find out on the air.
--
--   1. alert_allocation          one address set aside in one hub: what for, the
--                                repeater whose range it was taken from and the
--                                station it is for when there is one, who set
--                                it aside and when, and — once it is no longer
--                                needed — who released it, when and why. Rows
--                                set aside together share a batch.
--   2. allocate_alert_ids()      the door in. Editors. All or nothing: an
--                                address out of 1–8191, held by a station in
--                                the hub, already set aside there, or outside
--                                the named repeater's pass ranges refuses the
--                                lot, in words naming it.
--   3. release_alert_allocation() the door out. Editors. Soft: the row stays.
--
-- What it does not do: write a sensor. An address is a station's when the
-- station editor saves it onto a sensor, exactly as before; the Pass Ranges
-- tab then shows the allocation as taken up by that station, and offers to
-- release it. Nothing here touches save_station(), the document, or the pass
-- ranges themselves.
--
-- Reading: approved accounts (is_member(), 0062) — an address set aside is a
-- plan, not a secret, but it carries the address of whoever set it aside,
-- which is not for the open internet. Not in the agent API.
--
-- Depends on 0002 (station, sensor, pass_range), 0004 (is_editor, actor,
-- touch_updated_at), 0027 (hub, station.hub_id), 0062 (is_member).
-- tools/check_alert_allocations.sql proves it.

-- ── 1. The allocations ───────────────────────────────────────────────────────

create table if not exists meganet.alert_allocation (
  id           uuid         primary key default gen_random_uuid(),
  batch        uuid         not null,
  hub_id       text         not null references meganet.hub (id),
  alert_id     integer      not null,
  purpose      text         not null,
  repeater_id  text         references meganet.station (id) on delete set null,
  station_id   text         references meganet.station (id) on delete set null,
  created_by   text         not null,
  created_at   timestamptz  not null default now(),
  released_at  timestamptz,
  released_by  text,
  release_note text         not null default '',
  updated_at   timestamptz  not null default now(),
  constraint alert_allocation_address check (alert_id between 1 and 8191),
  constraint alert_allocation_purpose check (length(purpose) between 3 and 200 and purpose = btrim(purpose)),
  constraint alert_allocation_note check (length(release_note) <= 500),
  constraint alert_allocation_released check ((released_at is null) = (released_by is null))
);

comment on table meganet.alert_allocation is
  'An ALERT address set aside in one hub before any station holds it (0084): what for, the repeater whose pass range it came from, the station it is for, who and when; released softly. Written only by allocate_alert_ids() and release_alert_allocation(). Approved accounts read it.';
-- hub_id refuses a delete on purpose: a stations.json load that drops a hub
-- (load_stations_doc() prunes the ones the document lacks) stops there rather
-- than taking the hub's allocations with it. The station references only
-- lose their station.
comment on column meganet.alert_allocation.batch is
  'Rows set aside by one allocate_alert_ids() call share it — a rain gauge''s rainfall and battery addresses are one allocation of two.';

-- One live allocation of an address in a hub. A released row keeps its
-- address, so the same address can be set aside again afterwards.
create unique index if not exists alert_allocation_live
  on meganet.alert_allocation (hub_id, alert_id) where released_at is null;
create index if not exists alert_allocation_batch on meganet.alert_allocation (batch);

drop trigger if exists alert_allocation_touch_updated_at on meganet.alert_allocation;
create trigger alert_allocation_touch_updated_at
  before update on meganet.alert_allocation
  for each row execute function meganet.touch_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────

alter table meganet.alert_allocation enable row level security;
drop policy if exists alert_allocation_read_members on meganet.alert_allocation;
create policy alert_allocation_read_members on meganet.alert_allocation
  for select to authenticated using ((select meganet.is_member()));

-- ── 2. The door in ───────────────────────────────────────────────────────────

-- Does a repeater pass an address — a pass range holds it and no exclusion
-- does? The app's passRangeCoversId(), as rows: an inverted range is empty in
-- both (0002).
create or replace function meganet.repeater_passes(p_repeater text, p_alert_id integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from meganet.pass_range r
                  where r.repeater_id = p_repeater and r.kind = 'pass' and r.span @> p_alert_id)
     and not exists (select 1 from meganet.pass_range r
                      where r.repeater_id = p_repeater and r.kind = 'exclusion' and r.span @> p_alert_id)
$$;

comment on function meganet.repeater_passes(text, integer) is
  'Whether a repeater''s pass ranges carry an ALERT address, after its exclusions — the app''s passRangeCoversId() (0084). Internal.';

-- Set aside one or more addresses in a hub, for a stated purpose. The repeater
-- and the station are optional; given, they have to be ones the register has,
-- and the repeater has to carry every address. Answers the rows as kept.
create or replace function meganet.allocate_alert_ids(
  p_hub_id      text,
  p_ids         integer[],
  p_purpose     text,
  p_repeater_id text default null,
  p_station_id  text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   text := meganet.actor();
  v_batch   uuid := gen_random_uuid();
  v_purpose text;
  v_rep     text := nullif(pg_catalog.btrim(coalesce(p_repeater_id, '')), '');
  v_stn     text := nullif(pg_catalog.btrim(coalesce(p_station_id, '')), '');
  v_hub     text;
  v_bad     text;
  v_rows    jsonb;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to set ALERT addresses aside'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;

  select h.id into v_hub from meganet.hub h where h.id = p_hub_id;
  if v_hub is null then
    raise exception 'there is no hub "%"', coalesce(p_hub_id, '') using errcode = '22023';
  end if;

  if p_ids is null or pg_catalog.cardinality(p_ids) = 0 then
    raise exception 'say which addresses to set aside' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(p_ids) > 16 then
    raise exception 'at most 16 addresses at a time, not %', pg_catalog.cardinality(p_ids) using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_ids) a where a is null or a not between 1 and 8191) then
    raise exception 'an ALERT address is 1 to 8191: % is not one',
      (select coalesce(a::text, 'nothing') from pg_catalog.unnest(p_ids) a
        where a is null or a not between 1 and 8191 limit 1)
      using errcode = '22023';
  end if;
  if (select count(distinct a) from pg_catalog.unnest(p_ids) a) <> pg_catalog.cardinality(p_ids) then
    raise exception 'an address is named twice' using errcode = '22023';
  end if;

  v_purpose := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_purpose, ''), '\s+', ' ', 'g'));
  if pg_catalog.length(v_purpose) < 3 then
    raise exception 'say what the addresses are for — a site, a station, a plan' using errcode = '22023';
  end if;
  if pg_catalog.length(v_purpose) > 200 then
    raise exception 'what they are for is at most 200 characters' using errcode = '22023';
  end if;

  if v_rep is not null then
    if not exists (select 1 from meganet.repeater r join meganet.station s on s.id = r.station_id
                    where r.station_id = v_rep and s.deleted_at is null) then
      raise exception 'there is no repeater "%"', v_rep using errcode = '22023';
    end if;
    select pg_catalog.string_agg(a::text, ', ' order by a) into v_bad
      from pg_catalog.unnest(p_ids) a where not meganet.repeater_passes(v_rep, a);
    if v_bad is not null then
      raise exception '%''s pass ranges do not carry %', (select s.name from meganet.station s where s.id = v_rep), v_bad
        using errcode = '22023',
              hint    = 'pick addresses inside its ranges, or allocate in the hub without naming the repeater';
    end if;
  end if;

  if v_stn is not null and not exists (select 1 from meganet.station s where s.id = v_stn and s.deleted_at is null) then
    raise exception 'there is no station "%"', v_stn using errcode = '22023';
  end if;

  -- Held by a station in the hub already: the address is that station's.
  select pg_catalog.string_agg(pg_catalog.format('%s (%s)', x.alert_id, x.name), ', ' order by x.alert_id) into v_bad
    from (select distinct se.alert_id, s.name
            from meganet.sensor se join meganet.station s on s.id = se.station_id
           where s.hub_id = v_hub and s.deleted_at is null and se.alert_id = any (p_ids)) x;
  if v_bad is not null then
    raise exception 'already held by a station in this hub: %', v_bad using errcode = '23505';
  end if;

  -- Set aside already: named here rather than left to the index, so the
  -- refusal says which and for what.
  select pg_catalog.string_agg(pg_catalog.format('%s (%s)', a.alert_id, a.purpose), ', ' order by a.alert_id) into v_bad
    from meganet.alert_allocation a
   where a.hub_id = v_hub and a.released_at is null and a.alert_id = any (p_ids);
  if v_bad is not null then
    raise exception 'already set aside in this hub: %', v_bad using errcode = '23505';
  end if;

  begin
    with ins as (
      insert into meganet.alert_allocation (batch, hub_id, alert_id, purpose, repeater_id, station_id, created_by)
      select v_batch, v_hub, a, v_purpose, v_rep, v_stn, v_actor
        from pg_catalog.unnest(p_ids) a
      returning *
    )
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ins) order by ins.alert_id) into v_rows from ins;
  exception
    when unique_violation then
      -- Somebody else set one of them aside between the check and the insert.
      raise exception 'one of those addresses was set aside a moment ago by somebody else'
        using errcode = '23505',
              hint    = 'reload the allocations and pick again';
  end;
  return v_rows;
end;
$$;

comment on function meganet.allocate_alert_ids(text, integer[], text, text, text) is
  'Set aside ALERT addresses in a hub (0084): all or nothing, refused in words when one is out of range, held by a station in the hub, already set aside there, or outside the named repeater''s pass ranges. Editors. Answers the rows kept.';

-- ── 3. The door out ──────────────────────────────────────────────────────────

-- Release allocations, softly. Releasing one already released answers it as
-- it is; an id that is not an allocation is refused.
create or replace function meganet.release_alert_allocation(p_ids uuid[], p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := meganet.actor();
  v_note  text := pg_catalog.btrim(coalesce(p_note, ''));
  v_rows  jsonb;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to release ALERT addresses'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p_ids is null or pg_catalog.cardinality(p_ids) = 0 then
    raise exception 'say which allocations to release' using errcode = '22023';
  end if;
  if pg_catalog.length(v_note) > 500 then
    raise exception 'a note is at most 500 characters' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_ids) i
              where not exists (select 1 from meganet.alert_allocation a where a.id = i)) then
    raise exception 'that is not an allocation the database has' using errcode = '22023';
  end if;

  update meganet.alert_allocation a
     set released_at = now(), released_by = v_actor, release_note = v_note
   where a.id = any (p_ids) and a.released_at is null;

  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by a.alert_id) into v_rows
    from meganet.alert_allocation a where a.id = any (p_ids);
  return v_rows;
end;
$$;

comment on function meganet.release_alert_allocation(uuid[], text) is
  'Release ALERT address allocations (0084), with an optional note: the rows stay, with who and when. Editors. Answers the rows.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The writers and the internals revoked from public in the same file
-- (db/README.md); the doors granted to the two roles a request can be.

revoke all on function meganet.repeater_passes(text, integer)                         from public;
revoke all on function meganet.allocate_alert_ids(text, integer[], text, text, text) from public;
revoke all on function meganet.release_alert_allocation(uuid[], text)                from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke insert, update, delete, truncate on meganet.alert_allocation from anon, authenticated;
  revoke select on meganet.alert_allocation from anon;
  grant select on meganet.alert_allocation to authenticated, service_role;
  grant execute on function meganet.allocate_alert_ids(text, integer[], text, text, text) to authenticated, service_role;
  grant execute on function meganet.release_alert_allocation(uuid[], text)                to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.alert_allocation') is null
     or pg_catalog.to_regprocedure('meganet.allocate_alert_ids(text, integer[], text, text, text)') is null
     or pg_catalog.to_regprocedure('meganet.release_alert_allocation(uuid[], text)') is null then
    raise exception '0084 did not take: a table or function is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.alert_allocation'::regclass) then
    raise exception '0084 did not take: alert_allocation has no RLS';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 84 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '84')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
