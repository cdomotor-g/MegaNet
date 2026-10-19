-- 0069_stations_doc_cache.sql — The station document, kept: built when the
-- stations change, not on every page load.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0069_stations_doc_cache.sql
--
-- Why this file exists
-- ────────────────────
-- Every page load asks for the whole station document (GET
-- /rest/v1/rpc/stations_doc), and until this file every one of them built it
-- again from seventeen tables: 4,874 stations, about 7.5 MB. 0037 measured
-- that at ~1.6 s. By October it took 1.9–2.3 s on a quiet database and more
-- on a busy one, and Supabase gives a signed-out caller (`anon`) 3 s a
-- statement — so the app said *Could not load from the datastore: canceling
-- statement due to statement timeout* and fell back to the copy of
-- stations.json on the site. pg_stat_statements had it at 879 calls averaging
-- 1.3 s, the most expensive read in the project by a distance.
--
-- The document changes when somebody edits a station — a few times a day at
-- most — and is read on every visit. So now it is built when it changes and
-- kept, and a read is one row: ~40 ms where it was ~2 s.
--
-- Three decisions.
--
-- **1. Built by the change, as it commits.** A trigger on every table the
-- document reads notes that the transaction changed it; a deferred trigger
-- builds the document again as that transaction commits, and the new copy
-- commits with the change. So no committed change is ever missing from the
-- copy — no schedule, no window, no stale read — and the cost lands on the
-- edit (one build at commit, however many statements it ran) rather than on
-- every visitor. Builds take turns on the kept row, and each starts after the
-- one before it has committed, so the last to commit includes everything.
-- Nothing is locked until commit, so two editors saving at once queue for the
-- length of a build and cannot deadlock each other.
--
-- **2. The same document, to the byte, from the same function.**
-- stations_doc() keeps its name, its jsonb, its security invoker and its
-- grants; app.js, sw.js, pwa.js, datastore.js, tools/ and every check that
-- calls it are untouched. Inside a transaction that has changed a station and
-- not yet committed, it builds the document as it stands, so a check that
-- edits a station and reads the document back still sees its edit.
-- stations_json is unchanged and is still the definition: the kept copy is
-- only ever `select doc from meganet.stations_json`.
--
-- **3. Every table the document reads is watched — found, not listed.**
-- stations_doc_reads() walks the views' dependencies in pg_depend, and
-- stations_doc_watch() puts the trigger on every table it finds, takes it off
-- any it no longer reads and builds the copy. A migration that changes
-- station_json or stations_json — a new list, a new table — ends with
-- `select meganet.stations_doc_watch();`, and tools/check_stations_doc_cache.sql
-- fails if a table the document reads is not watched or the copy is not the
-- document. So does anything that changes the stations with triggers off
-- (session_replication_role = replica, as a restore does): it should end with
-- `select meganet.stations_doc_refresh();`.
--
-- The document is the same for everyone — every table it reads is read-all —
-- which is what makes one kept copy right. A station some callers may not see
-- does not belong in it.
--
-- Depends on 0002 (the document) and 0037 (station_flood_peak_top, one of the
-- tables it reads). tools/check_stations_doc_cache.sql proves it.

-- ── The copy ─────────────────────────────────────────────────────────────────

create table if not exists meganet.stations_doc_cache (
  one       boolean      primary key default true,
  doc       jsonb        not null,
  built_at  timestamptz  not null default now(),
  constraint stations_doc_cache_one check (one)
);

comment on table meganet.stations_doc_cache is
  'The station document as of the last committed change — what stations_doc() returns. One row, written only by meganet.stations_doc_refresh(): the trigger as a change commits, or a migration.';

alter table meganet.stations_doc_cache enable row level security;
drop policy if exists stations_doc_cache_read_all on meganet.stations_doc_cache;
create policy stations_doc_cache_read_all on meganet.stations_doc_cache
  for select using (true);

-- ── The transactions that have changed it ───────────────────────────────────
-- A row for each transaction that has changed a table the document reads and
-- not yet committed: put there by the first such statement, taken away by the
-- build as it commits. Nobody else can see a transaction's row before then, and
-- it is gone after, so to everyone but the writer this table is empty. It is
-- how stations_doc() knows its own transaction has changed the stations, and
-- inserting the row is what queues the build.

create table if not exists meganet.stations_doc_change (
  xid  xid8  primary key
);

comment on table meganet.stations_doc_change is
  'One row for each transaction that has changed what the station document reads and not yet committed. Put there by meganet.stations_doc_touch(), taken away by the build at commit.';

alter table meganet.stations_doc_change enable row level security;
drop policy if exists stations_doc_change_read_all on meganet.stations_doc_change;
create policy stations_doc_change_read_all on meganet.stations_doc_change
  for select using (true);

-- ── Building it ──────────────────────────────────────────────────────────────

create or replace function meganet.stations_doc_refresh()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  at timestamptz;
begin
  -- Take turns. A build in progress holds the row until it commits; this waits
  -- for it, and the statement after takes a fresh snapshot, so what is built
  -- here includes what that one built from. (One statement would not do: an
  -- update's snapshot is taken before it waits for the row.)
  perform 1 from meganet.stations_doc_cache k for update;

  insert into meganet.stations_doc_cache as k (one, doc, built_at)
  select true, j.doc, pg_catalog.clock_timestamp() from meganet.stations_json j
  on conflict (one) do update set doc = excluded.doc, built_at = excluded.built_at
  returning k.built_at into at;
  return at;
end
$$;

revoke all on function meganet.stations_doc_refresh() from public;

comment on function meganet.stations_doc_refresh() is
  'Build the kept station document again from meganet.stations_json, now. The triggers do this as each change commits; call it after changing the stations with triggers off, or after changing what the document is worked out from without changing a row.';

-- A statement changed a table the document reads: note this transaction, once.
-- The first statement's insert queues the build; the rest find the row there.
create or replace function meganet.stations_doc_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into meganet.stations_doc_change (xid) values (pg_catalog.pg_current_xact_id())
  on conflict (xid) do nothing;
  return null;
end
$$;

revoke all on function meganet.stations_doc_touch() from public;

-- As the transaction commits: build, and take its row away.
create or replace function meganet.stations_doc_rebuild()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform meganet.stations_doc_refresh();
  delete from meganet.stations_doc_change c where c.xid = new.xid;
  return null;
end
$$;

revoke all on function meganet.stations_doc_rebuild() from public;

-- Deferred, so it runs once at commit after every statement has. Under SET
-- CONSTRAINTS … IMMEDIATE it runs after the statement instead — the touch is
-- an AFTER trigger, so the build still sees that statement's rows — and takes
-- the row away, so the next statement queues another.
drop trigger if exists stations_doc_change_rebuild on meganet.stations_doc_change;
create constraint trigger stations_doc_change_rebuild
  after insert on meganet.stations_doc_change
  deferrable initially deferred
  for each row execute function meganet.stations_doc_rebuild();

-- ── What it reads, and watching it ───────────────────────────────────────────

-- Every table stations_json reads, through station_json and any view under
-- it: the relations each view's rewrite rule depends on, followed down.
create or replace function meganet.stations_doc_reads()
returns setof regclass
language sql
stable
set search_path = ''
as $$
  with recursive reads(rel) as (
    select 'meganet.stations_json'::regclass::oid
    union
    select d.refobjid
      from reads r
      join pg_catalog.pg_rewrite w on w.ev_class = r.rel
      join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass
                                 and d.objid = w.oid
                                 and d.refclassid = 'pg_catalog.pg_class'::regclass
     where d.refobjid <> r.rel
  )
  select c.oid::regclass
    from reads
    join pg_catalog.pg_class c on c.oid = reads.rel
   where c.relkind in ('r', 'p')
   order by 1;
$$;

revoke all on function meganet.stations_doc_reads() from public;

comment on function meganet.stations_doc_reads() is
  'Every table meganet.stations_json reads, found through pg_depend. The ones meganet.stations_doc_watch() keeps a trigger on.';

-- Put the trigger on every table the document reads, take it off any it no
-- longer reads, and build the copy. Returns how many tables are watched.
create or replace function meganet.stations_doc_watch()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  t regclass;
  n integer := 0;
begin
  for t in
    select g.tgrelid::regclass from pg_catalog.pg_trigger g
     where g.tgname = 'stations_doc_touch'
       and g.tgrelid not in (select r from meganet.stations_doc_reads() r)
  loop
    execute pg_catalog.format('drop trigger stations_doc_touch on %s', t);
  end loop;

  for t in select r from meganet.stations_doc_reads() r
  loop
    execute pg_catalog.format(
      'create or replace trigger stations_doc_touch
         after insert or update or delete or truncate on %s
         for each statement execute function meganet.stations_doc_touch()', t);
    n := n + 1;
  end loop;

  perform meganet.stations_doc_refresh();
  return n;
end
$$;

revoke all on function meganet.stations_doc_watch() from public;

comment on function meganet.stations_doc_watch() is
  'Keep the station document''s trigger on every table it reads, and build it. A migration that changes station_json or stations_json ends with select meganet.stations_doc_watch().';

-- ── The read ─────────────────────────────────────────────────────────────────
-- The kept copy, unless this transaction has changed the stations and not yet
-- committed — then the document as it stands, which is what it was before
-- this file. A reader that has written nothing has no transaction id, so the
-- first half never matches for it.

create or replace function meganet.stations_doc()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when exists (select 1 from meganet.stations_doc_change c
                  where c.xid = pg_catalog.pg_current_xact_id_if_assigned())
      then (select j.doc from meganet.stations_json j)
    else coalesce((select k.doc from meganet.stations_doc_cache k),
                  (select j.doc from meganet.stations_json j))
  end;
$$;

comment on function meganet.stations_doc() is
  'The whole stations document, for GET /rest/v1/rpc/stations_doc. Body is the document itself — the kept copy (meganet.stations_doc_cache), or inside a transaction that has changed the stations, the document as it stands.';

-- ── Watch, and build ─────────────────────────────────────────────────────────

select meganet.stations_doc_watch();

-- ── Supabase Data API (PostgREST) ────────────────────────────────────────────
-- Both tables are read by stations_doc() as the caller, so the caller may read
-- them; nobody but the functions above writes either. stations_doc() keeps
-- 0002's grants.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.stations_doc_cache, meganet.stations_doc_change
    to anon, authenticated, service_role;
  revoke insert, update, delete, truncate
      on meganet.stations_doc_cache, meganet.stations_doc_change
    from anon, authenticated, service_role;
  grant execute on function meganet.stations_doc_refresh() to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
declare
  reads   integer := (select count(*) from meganet.stations_doc_reads());
  watched integer;
begin
  if reads < 17 then
    raise exception '0069 did not take: stations_doc_reads() finds % tables, and the document reads at least 17', reads;
  end if;
  select count(*) into watched
    from pg_catalog.pg_trigger g
   where g.tgname = 'stations_doc_touch'
     and g.tgrelid in (select r from meganet.stations_doc_reads() r);
  if watched <> reads then
    raise exception '0069 did not take: % of the % tables the document reads are watched', watched, reads;
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger g
                  where g.tgname = 'stations_doc_change_rebuild'
                    and g.tgrelid = 'meganet.stations_doc_change'::regclass
                    and g.tgdeferrable and g.tginitdeferred) then
    raise exception '0069 did not take: the build at commit is missing, or not deferred';
  end if;
  if (select count(*) from pg_catalog.pg_class c
       where c.oid in ('meganet.stations_doc_cache'::regclass, 'meganet.stations_doc_change'::regclass)
         and c.relrowsecurity) <> 2 then
    raise exception '0069 did not take: RLS is not enabled on both tables';
  end if;
  if (select k.doc from meganet.stations_doc_cache k)
       is distinct from (select j.doc from meganet.stations_json j) then
    raise exception '0069 did not take: the kept copy is not the document';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 69 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '69')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
