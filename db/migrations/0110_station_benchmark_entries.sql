-- 0110_station_benchmark_entries.sql — Benchmarks an editor adds to a station,
-- beside the Bureau's: a mark the report does not list, or one put in since it
-- was printed. And one person's name taken out of the Bureau's comments.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0110_station_benchmark_entries.sql
--
-- Why this file exists
-- ────────────────────
-- 0101 holds HDB's *Benchmark Details* as printed (15/10/2026: 777 benchmarks
-- at 519 stations), and its loader makes meganet.bureau_benchmark match the
-- report: nothing else writes that table, so there was nowhere to put a mark a
-- crew set last week, or one the Bureau's list has never had. The owner asked
-- (10 November 2026) for a way to add them from the station editor and the
-- station card.
--
-- What is stored, and in what shape
-- ─────────────────────────────────
-- A table of its own, so the two never mix: re-loading the Bureau's report
-- (load_benchmarks_doc) replaces bureau_benchmark and cannot touch a row here.
--
--   meganet.station_benchmark_entry    one row per benchmark an editor entered,
--                                      on the station by its id (a station's
--                                      own record, not the Bureau's, so not by
--                                      bureau number): level, datum, what it is
--                                      and where, comments, the day surveyed,
--                                      where the figure came from, who entered
--                                      and last changed it. Removing one stamps
--                                      it (removed_at) rather than deleting it.
--   meganet.station_benchmark_entered  the ones still standing, on live
--                                      stations, with the gauge zero in force
--                                      and the level on the gauge — 0101's
--                                      view, the same rule and arithmetic.
--
-- The datum is one of the report's four (AHD, ASSUM, STATE, UNKNOWN — the
-- codes of meganet.gauge_datum), or GH — a level given on the gauge itself,
-- which is then its own level on the gauge — or OTHER, named in datum_other.
-- GH and OTHER are not added to meganet.gauge_datum: that list is what a gauge
-- zero can be in, and a gauge zero is never "on the gauge".
--
-- Who reads and writes it
-- ───────────────────────
-- Editors, both: 0101's reason (what a mark is and where — a bolt in a tree
-- beside a house — is not for the open internet). Writes go through two
-- functions, as every editors' write does (0004):
--
--   meganet.station_benchmark_entry_save(jsonb)    add one, or change one by id
--   meganet.station_benchmark_entry_remove(uuid)   take one off the station
--
-- Nothing here is published to `anon` and nothing is in the agent API.
--
-- The name taken out
-- ──────────────────
-- One comment in the report names the person who re-installed a mark for a
-- council. Flood-Net keeps no private person's name with a site, so it goes:
-- from the table here, and from the reader (tools/ingest/benchmarks.py drops a
-- name in brackets after "contractor"), so a re-load does not bring it back.
--
-- Depends on 0002 (station), 0004 (is_editor, actor, touch_updated_at), 0031
-- (station_gauge_survey), 0101 (bureau_benchmark).
-- tools/check_station_benchmarks.sql proves it.

-- ── The table ────────────────────────────────────────────────────────────────

create table if not exists meganet.station_benchmark_entry (
  id           uuid          primary key default gen_random_uuid(),
  station_id   text          not null references meganet.station (id) on delete cascade,
  -- The mark's level in metres, in its datum, to the millimetre at most.
  level_m      numeric(9,3)  not null,
  datum        text          not null,
  datum_other  text          not null default '',
  description  text          not null,
  comment      text          not null default '',
  surveyed_on  date,
  source       text          not null default 'Entered in Flood-Net',
  created_by   text          not null,
  created_at   timestamptz   not null default now(),
  updated_by   text,
  updated_at   timestamptz   not null default now(),
  removed_by   text,
  removed_at   timestamptz,
  constraint station_benchmark_entry_level check (level_m between -500 and 9000),
  constraint station_benchmark_entry_datum check (datum in ('AHD', 'ASSUM', 'STATE', 'UNKNOWN', 'GH', 'OTHER')),
  constraint station_benchmark_entry_other check (
    (datum = 'OTHER' and length(btrim(datum_other)) between 1 and 40) or (datum <> 'OTHER' and datum_other = '')),
  constraint station_benchmark_entry_description check (length(btrim(description)) between 1 and 500),
  constraint station_benchmark_entry_lengths check (length(comment) <= 500 and length(btrim(source)) between 1 and 200)
);

comment on table meganet.station_benchmark_entry is
  'Benchmarks an editor entered for a station (0110), beside the Bureau''s (meganet.bureau_benchmark, which only its loader writes): level, datum, what the mark is and where, comments, the day surveyed and where the figure came from. Editors read; writes go through station_benchmark_entry_save() and _remove(), which stamps removed_at rather than deleting.';
comment on column meganet.station_benchmark_entry.datum is
  'AHD, ASSUM, STATE or UNKNOWN (meganet.gauge_datum''s codes), GH — a level on the gauge itself — or OTHER, named in datum_other.';

create index if not exists station_benchmark_entry_station
  on meganet.station_benchmark_entry (station_id) where removed_at is null;

drop trigger if exists station_benchmark_entry_touch_updated_at on meganet.station_benchmark_entry;
create trigger station_benchmark_entry_touch_updated_at before update on meganet.station_benchmark_entry
  for each row execute function meganet.touch_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────
-- Editors read. No policy lets a browser write: the two functions below do,
-- as their owner, after asking is_editor() themselves.

alter table meganet.station_benchmark_entry enable row level security;
drop policy if exists station_benchmark_entry_read_editors on meganet.station_benchmark_entry;
create policy station_benchmark_entry_read_editors on meganet.station_benchmark_entry
  for select to authenticated using (meganet.is_editor());

-- ── On the stations ──────────────────────────────────────────────────────────

create or replace view meganet.station_benchmark_entered
with (security_invoker = true) as
select e.id,
       e.station_id,
       s.station_number,
       e.level_m,
       e.datum,
       e.datum_other,
       e.description,
       e.comment,
       e.surveyed_on,
       e.source,
       z.gauge_zero_m,
       z.datum              as gauge_datum,
       z.valid_from         as gauge_zero_from,
       case when e.datum = 'GH' then e.level_m
            when e.datum in ('AHD', 'STATE') and z.datum = e.datum
            then e.level_m - z.gauge_zero_m end as on_gauge_m,
       e.created_by,
       e.created_at,
       e.updated_by,
       e.updated_at
  from meganet.station_benchmark_entry e
  join meganet.station s on s.id = e.station_id and s.deleted_at is null
  left join lateral (
        select v.gauge_zero_m, v.datum, v.valid_from
          from meganet.station_gauge_survey v
         where v.station_id = s.id and v.gauge_zero_m is not null
         order by (v.valid_to is null) desc,
                  case when v.valid_to is null then v.valid_from end desc nulls last,
                  v.valid_to desc nulls last,
                  v.ord
         limit 1) z on true
 where e.removed_at is null;

comment on view meganet.station_benchmark_entered is
  'The benchmarks editors entered that still stand, on live stations (0110), with the gauge zero in force and on_gauge_m — the level itself for a GH entry, the level less the zero where both are AHD or both State, null otherwise (0101''s rule). security_invoker, so the table''s RLS answers: editors only.';

-- ── Adding one, or changing one ──────────────────────────────────────────────
-- p: { id?, station_id, level_m, datum, datum_other?, description, comment?,
--      surveyed_on?, source? }. With no id it is a new benchmark; with one, that
-- benchmark is changed (its station is not: a mark does not move between
-- stations). Answers the row as meganet.station_benchmark_entered has it.

create or replace function meganet.station_benchmark_entry_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   text := meganet.actor();
  v_key     text;
  v_id      uuid;
  v_station text;
  v_level   numeric;
  v_datum   text;
  v_other   text;
  v_desc    text;
  v_comment text;
  v_source  text;
  v_on      date;
  v_out     jsonb;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to add a benchmark'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.station_benchmark_entry_save() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('id', 'station_id', 'level_m', 'datum', 'datum_other', 'description', 'comment', 'surveyed_on', 'source') then
      raise exception 'meganet.station_benchmark_entry_save() does not take %', v_key
        using errcode = '22023',
              hint    = 'id, station_id, level_m, datum, datum_other, description, comment, surveyed_on and source are the whole list';
    end if;
  end loop;

  begin
    v_id := nullif(p ->> 'id', '')::uuid;
  exception when others then
    raise exception 'a benchmark''s id is a uuid, not %', p ->> 'id' using errcode = '22023';
  end;
  begin
    v_level := nullif(pg_catalog.btrim(p ->> 'level_m'), '')::numeric;
  exception when others then
    raise exception 'the level has to be a number of metres, not %', p ->> 'level_m' using errcode = '22023';
  end;
  if v_level is null or v_level = 'NaN'::numeric or v_level not between -500 and 9000 then
    raise exception 'a benchmark needs its level in metres, between -500 and 9000' using errcode = '22023';
  end if;
  v_level := pg_catalog.round(v_level, 3);

  v_datum := pg_catalog.upper(pg_catalog.btrim(coalesce(p ->> 'datum', '')));
  if v_datum not in ('AHD', 'ASSUM', 'STATE', 'UNKNOWN', 'GH', 'OTHER') then
    raise exception 'the datum is AHD, ASSUM, STATE, UNKNOWN, GH or OTHER, not %', coalesce(nullif(v_datum, ''), 'nothing')
      using errcode = '22023';
  end if;
  v_other := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'datum_other', ''), '\s+', ' ', 'g'));
  if v_datum = 'OTHER' and (v_other = '' or pg_catalog.length(v_other) > 40) then
    raise exception 'another datum needs its name, in at most 40 characters' using errcode = '22023';
  end if;
  if v_datum <> 'OTHER' then
    v_other := '';
  end if;

  v_desc    := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'description', ''), '\s+', ' ', 'g'));
  v_comment := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'comment', ''), '\s+', ' ', 'g'));
  v_source  := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p ->> 'source', ''), '\s+', ' ', 'g'));
  if v_source = '' then
    v_source := 'Entered in Flood-Net';
  end if;
  if v_desc = '' then
    raise exception 'a benchmark needs a description: what the mark is and where' using errcode = '22023';
  end if;
  if pg_catalog.length(v_desc) > 500 or pg_catalog.length(v_comment) > 500 or pg_catalog.length(v_source) > 200 then
    raise exception 'a description or a comment is at most 500 characters, a source 200' using errcode = '22023';
  end if;

  begin
    v_on := nullif(pg_catalog.btrim(p ->> 'surveyed_on'), '')::date;
  exception when others then
    raise exception 'the day surveyed has to be a date, not %', p ->> 'surveyed_on' using errcode = '22023';
  end;
  if v_on is not null and (v_on < date '1850-01-01' or v_on > (pg_catalog.now() at time zone 'Australia/Brisbane')::date + 1) then
    raise exception 'the day surveyed is between 1850 and today, not %', v_on using errcode = '22023';
  end if;

  if v_id is null then
    v_station := nullif(pg_catalog.btrim(p ->> 'station_id'), '');
    if v_station is null
       or not exists (select 1 from meganet.station s where s.id = v_station and s.deleted_at is null) then
      raise exception 'no station %', coalesce(v_station, '(none given)') using errcode = 'P0002';
    end if;
    insert into meganet.station_benchmark_entry
           (station_id, level_m, datum, datum_other, description, comment, surveyed_on, source, created_by, updated_by)
    values (v_station, v_level, v_datum, v_other, v_desc, v_comment, v_on, v_source, v_actor, v_actor)
    returning id into v_id;
  else
    update meganet.station_benchmark_entry e
       set level_m = v_level, datum = v_datum, datum_other = v_other, description = v_desc,
           comment = v_comment, surveyed_on = v_on, source = v_source, updated_by = v_actor
     where e.id = v_id and e.removed_at is null
       and (p ->> 'station_id' is null or e.station_id = p ->> 'station_id');
    if not found then
      raise exception 'no such benchmark on that station — it may have been removed' using errcode = 'P0002';
    end if;
  end if;

  select pg_catalog.to_jsonb(x) into v_out from meganet.station_benchmark_entered x where x.id = v_id;
  return pg_catalog.jsonb_build_object('benchmark', v_out);
end
$$;

comment on function meganet.station_benchmark_entry_save(jsonb) is
  'Add a benchmark to a station, or change one by its id (0110). Editors only. Answers {benchmark: the row as meganet.station_benchmark_entered has it}.';

-- ── Taking one off ───────────────────────────────────────────────────────────
-- Stamped, not deleted: the row stays for whoever asks what was there.

create or replace function meganet.station_benchmark_entry_remove(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := meganet.actor();
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to remove a benchmark'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  update meganet.station_benchmark_entry e
     set removed_at = pg_catalog.now(), removed_by = v_actor, updated_by = v_actor
   where e.id = p_id and e.removed_at is null;
  if not found then
    raise exception 'no such benchmark — it may already have been removed' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('removed', p_id);
end
$$;

comment on function meganet.station_benchmark_entry_remove(uuid) is
  'Take an entered benchmark off its station (0110): stamps removed_at and removed_by; the row is kept. Editors only.';

revoke all on function meganet.station_benchmark_entry_save(jsonb)  from public;
revoke all on function meganet.station_benchmark_entry_remove(uuid) from public;

-- ── The name taken out of the Bureau's comments ──────────────────────────────
-- A person's name in brackets after "contractor" goes; the rest of the comment
-- stays. The same rule as tools/ingest/benchmarks.py's REDACT, so the table
-- still matches what the reader writes. Nothing to do on a database with no
-- such row, or on a second run.

update meganet.bureau_benchmark b
   set comment = pg_catalog.regexp_replace(b.comment, '(contractor)\s*\([A-Z][a-z]+ [A-Z][a-z]+\)', '\1'),
       updated_by = '0110'
 where b.comment ~ 'contractor\s*\([A-Z][a-z]+ [A-Z][a-z]+\)';

-- ── Data API ─────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.station_benchmark_entry, meganet.station_benchmark_entered from anon;
  revoke insert, update, delete, truncate
      on meganet.station_benchmark_entry, meganet.station_benchmark_entered
    from authenticated;
  revoke execute on function meganet.station_benchmark_entry_save(jsonb)  from anon;
  revoke execute on function meganet.station_benchmark_entry_remove(uuid) from anon;
  grant select on meganet.station_benchmark_entry, meganet.station_benchmark_entered
    to authenticated, service_role;
  grant insert, update, delete on meganet.station_benchmark_entry to service_role;
  grant execute on function meganet.station_benchmark_entry_save(jsonb)  to authenticated, service_role;
  grant execute on function meganet.station_benchmark_entry_remove(uuid) to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.station_benchmark_entry') is null then
    raise exception '0110 did not take: meganet.station_benchmark_entry is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c
           where c.oid = 'meganet.station_benchmark_entry'::regclass) then
    raise exception '0110 did not take: RLS is off on meganet.station_benchmark_entry';
  end if;
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = pg_catalog.to_regclass('meganet.station_benchmark_entered')
                    and 'security_invoker=true' = any (c.reloptions)) then
    raise exception '0110 did not take: meganet.station_benchmark_entered is missing, or reads past RLS';
  end if;
  if pg_catalog.to_regprocedure('meganet.station_benchmark_entry_save(jsonb)') is null
     or pg_catalog.to_regprocedure('meganet.station_benchmark_entry_remove(uuid)') is null then
    raise exception '0110 did not take: a function is missing';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.station_benchmark_entry_save(jsonb)', 'execute')
     or pg_catalog.has_function_privilege('public', 'meganet.station_benchmark_entry_remove(uuid)', 'execute') then
    raise exception '0110 did not take: public may write a benchmark';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and (pg_catalog.has_table_privilege('anon', 'meganet.station_benchmark_entry', 'select')
          or pg_catalog.has_table_privilege('anon', 'meganet.station_benchmark_entered', 'select')
          or pg_catalog.has_function_privilege('anon', 'meganet.station_benchmark_entry_save(jsonb)', 'execute')) then
    raise exception '0110 did not take: anon may read or write the entered benchmarks';
  end if;
  if exists (select 1 from meganet.bureau_benchmark b
              where b.comment ~ 'contractor\s*\([A-Z][a-z]+ [A-Z][a-z]+\)') then
    raise exception '0110 did not take: a contractor''s name is still in a comment';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 110 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '110')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
