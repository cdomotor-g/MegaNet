-- check_stations_doc_cache.sql — Prove the kept station document (0069)
-- against a real database: that it is the document, that every table the
-- document reads keeps it current, and that a change is built in as it
-- commits and not before.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_stations_doc_cache.sql
--
-- Every check below is one claim the head of 0069_stations_doc_cache.sql makes.
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database: nothing it writes survives. It needs a direct
-- psql connection (it changes triggers to prove the watch puts them back), and
-- prints a row per check, exiting non-zero if any failed. CI runs it in the
-- db-checks job (.github/workflows/web-smoke.yml) after stations.json is
-- loaded — which is a committed change, so the first section is also the proof
-- that a commit builds the copy.
--
-- A commit cannot be made inside a transaction that rolls back, so the build
-- at commit is run here the way a commit runs it: SET CONSTRAINTS ALL IMMEDIATE
-- fires the deferred trigger there and then, through the same function.

\set ON_ERROR_STOP on

begin;

create temporary table _check (
  ord   serial,
  name  text,
  ok    boolean,
  note  text
) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

-- Run one statement as another role and say how it ended — 'ok', or the
-- SQLSTATE — then roll it back (check_station_facing.sql's helper).
create or replace function pg_temp.as_role(p_role text, p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    execute p_sql;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate;
      return v_state;
  end;
end;
$$;

-- Whether this transaction has a row saying it changed the stations.
create or replace function pg_temp.noted()
returns boolean language sql as $$
  select exists (select 1 from meganet.stations_doc_change c
                  where c.xid = pg_catalog.pg_current_xact_id_if_assigned());
$$;

create or replace function pg_temp.kept()
returns jsonb language sql as $$
  select k.doc from meganet.stations_doc_cache k;
$$;

create or replace function pg_temp.live()
returns jsonb language sql as $$
  select j.doc from meganet.stations_json j;
$$;

create or replace function pg_temp.name_in(p_doc jsonb, p_id text)
returns text language sql as $$
  select s ->> 'name' from jsonb_array_elements(p_doc -> 'stations') s where s ->> 'id' = p_id;
$$;

-- ── 1. The copy is the document ─────────────────────────────────────────────

select pg_temp.check_that('there is one kept copy',
  (select count(*) from meganet.stations_doc_cache) = 1);

select pg_temp.check_that('the kept copy is the document, to the byte',
  (select k.doc::text from meganet.stations_doc_cache k) = (select j.doc::text from meganet.stations_json j));

select pg_temp.check_that('stations_doc() returns it',
  meganet.stations_doc()::text = (select j.doc::text from meganet.stations_json j));

select pg_temp.check_that('no transaction is left noted as having changed the stations',
  not exists (select 1 from meganet.stations_doc_change));

-- The point of the file: a read serves the copy rather than building one. A
-- marker put in the copy by hand (the table's owner, so no trigger) comes back.
do $$
declare
  got jsonb;
begin
  begin
    update meganet.stations_doc_cache set doc = doc || '{"_checked": true}';
    got := meganet.stations_doc();
    raise exception using errcode = 'MNRLB';
  exception when sqlstate 'MNRLB' then null;
  end;
  perform pg_temp.check_that('a read serves the kept copy, not a fresh build',
    got ? '_checked' and not (meganet.stations_doc() ? '_checked'));
end
$$;

select pg_temp.check_that('stations_doc() is still jsonb, invoker and executable by anon',
  pg_catalog.pg_get_function_result('meganet.stations_doc()'::regprocedure) = 'jsonb'
  and not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'meganet.stations_doc()'::regprocedure)
  and pg_catalog.has_function_privilege('anon', 'meganet.stations_doc()', 'execute'));

-- ── 2. What it reads, and the triggers on it ────────────────────────────────

select pg_temp.check_that('the document reads at least the seventeen tables of 0069',
  (select count(*) from meganet.stations_doc_reads()) >= 17
  and (select pg_catalog.array_agg(r::text) from meganet.stations_doc_reads() r)
      @> array['meganet.station', 'meganet.sensor', 'meganet.repeater', 'meganet.pass_range',
               'meganet.station_flood_class', 'meganet.station_crossing', 'meganet.station_gauge_survey',
               'meganet.station_bureau_listing', 'meganet.station_flood_effect', 'meganet.station_aep_level',
               'meganet.station_frequency', 'meganet.station_flood_peak_top', 'meganet.doc_meta',
               'meganet.radio_network', 'meganet.catchment', 'meganet.hub', 'meganet.rm_system'],
  (select pg_catalog.string_agg(r::text, ', ') from meganet.stations_doc_reads() r));

select pg_temp.check_that('every table the document reads is watched, on every kind of change',
  not exists (
    select 1 from meganet.stations_doc_reads() r
     where not exists (
       select 1 from pg_catalog.pg_trigger g
        where g.tgrelid = r and g.tgname = 'stations_doc_touch' and g.tgenabled <> 'D'
          -- after (not before), for each statement, insert + delete + update + truncate
          and g.tgtype::integer & (1 | 2) = 0
          and g.tgtype::integer & (4 | 8 | 16 | 32) = (4 | 8 | 16 | 32))),
  (select pg_catalog.string_agg(r::text, ', ') from meganet.stations_doc_reads() r
    where not exists (select 1 from pg_catalog.pg_trigger g
                       where g.tgrelid = r and g.tgname = 'stations_doc_touch')));

select pg_temp.check_that('and no other table is',
  not exists (select 1 from pg_catalog.pg_trigger g
               where g.tgname = 'stations_doc_touch'
                 and g.tgrelid not in (select r from meganet.stations_doc_reads() r)));

select pg_temp.check_that('the build is a deferred trigger on each noted transaction',
  exists (select 1 from pg_catalog.pg_trigger g
           where g.tgrelid = 'meganet.stations_doc_change'::regclass
             and g.tgname = 'stations_doc_change_rebuild'
             and g.tgconstraint <> 0 and g.tgdeferrable and g.tginitdeferred));

-- Each table, proved by a statement on it: one that changes no row still says
-- the transaction touched what the document reads. Each in a subtransaction
-- that is rolled back, so each starts unnoted.
do $$
declare
  t      regclass;
  missed text[] := '{}';
  saw    boolean;
begin
  for t in select r from meganet.stations_doc_reads() r
  loop
    begin
      execute pg_catalog.format('delete from %s where false', t);
      saw := pg_temp.noted();
      raise exception using errcode = 'MNRLB';
    exception when sqlstate 'MNRLB' then
      if not saw then missed := missed || t::text; end if;
    end;
  end loop;
  perform pg_temp.check_that('a statement on any of them notes the transaction',
    pg_catalog.cardinality(missed) = 0, pg_catalog.array_to_string(missed, ', '));
  perform pg_temp.check_that('…and a rolled-back one leaves nothing noted', not pg_temp.noted());
end
$$;

do $$
declare
  saw boolean;
begin
  begin
    truncate meganet.station_frequency;
    saw := pg_temp.noted();
    raise exception using errcode = 'MNRLB';
  exception when sqlstate 'MNRLB' then null;
  end;
  perform pg_temp.check_that('so does a truncate', saw);
end
$$;

select pg_temp.check_that('a read notes nothing',
  meganet.stations_doc() is not null and not pg_temp.noted());

-- ── 3. Who may do what ───────────────────────────────────────────────────────

select pg_temp.check_that('both tables have RLS on',
  (select pg_catalog.bool_and(c.relrowsecurity) from pg_catalog.pg_class c
    where c.oid in ('meganet.stations_doc_cache'::regclass, 'meganet.stations_doc_change'::regclass)));

select pg_temp.check_that('anon reads the kept copy',
  pg_temp.as_role('anon', 'select doc from meganet.stations_doc_cache') = 'ok');

select pg_temp.check_that('anon cannot write it, or note a change',
  pg_temp.as_role('anon', 'update meganet.stations_doc_cache set doc = ''{}''') = '42501'
  and pg_temp.as_role('authenticated', 'delete from meganet.stations_doc_cache') = '42501'
  and pg_temp.as_role('authenticated', 'insert into meganet.stations_doc_change values (''1'')') = '42501');

select pg_temp.check_that('nobody but the owner can build it, or move the triggers',
  not pg_catalog.has_function_privilege('anon', 'meganet.stations_doc_refresh()', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'meganet.stations_doc_refresh()', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'meganet.stations_doc_watch()', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'meganet.stations_doc_reads()', 'execute'));

-- ── 4. A change, before and at commit ────────────────────────────────────────

do $$
declare
  pick     text := (select s.id from meganet.station s where s.deleted_at is null order by s.ord limit 1);
  was      text;
  before   timestamptz := (select k.built_at from meganet.stations_doc_cache k);
  now_doc  jsonb;
begin
  was := pg_temp.name_in(pg_temp.kept(), pick);
  update meganet.station set name = name || ' (checked)' where id = pick;

  perform pg_temp.check_that('a station renamed: the transaction is noted', pg_temp.noted());
  now_doc := meganet.stations_doc();
  perform pg_temp.check_that('…stations_doc() in it shows the new name',
    pg_temp.name_in(now_doc, pick) = was || ' (checked)', pg_temp.name_in(now_doc, pick));
  perform pg_temp.check_that('…and is the document as it stands', now_doc = pg_temp.live());
  perform pg_temp.check_that('…while the kept copy waits for the commit',
    pg_temp.name_in(pg_temp.kept(), pick) = was
    and (select k.built_at from meganet.stations_doc_cache k) = before);

  set constraints all immediate;

  perform pg_temp.check_that('at commit it is built: the kept copy has the new name',
    pg_temp.name_in(pg_temp.kept(), pick) = was || ' (checked)', pg_temp.name_in(pg_temp.kept(), pick));
  perform pg_temp.check_that('…is the document, to the byte',
    pg_temp.kept()::text = pg_temp.live()::text);
  perform pg_temp.check_that('…was built just now', (select k.built_at from meganet.stations_doc_cache k) > before);
  perform pg_temp.check_that('…and the transaction is no longer noted', not pg_temp.noted());

  -- Immediate from here: each statement is built as it ends.
  update meganet.sensor set type = type
   where station_id = (select s.station_id from meganet.sensor s order by s.station_id limit 1);
  insert into meganet.radio_network (id, ord, name, description)
  values ('_check_doc_cache', 999999, 'Check doc cache', 'rolled back');
  perform pg_temp.check_that('a second and third change, immediate: each built as its statement ended',
    not pg_temp.noted()
    and pg_temp.kept() -> 'radio_networks' @> '[{"id": "_check_doc_cache"}]'
    and pg_temp.kept()::text = pg_temp.live()::text);

  set constraints all deferred;

  delete from meganet.radio_network where id = '_check_doc_cache';
  perform pg_temp.check_that('deferred again: the next change waits for the commit',
    pg_temp.noted()
    and pg_temp.kept() -> 'radio_networks' @> '[{"id": "_check_doc_cache"}]'
    and not (meganet.stations_doc() -> 'radio_networks' @> '[{"id": "_check_doc_cache"}]'));

  -- What a commit does, once more, so what follows starts from a built copy.
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.check_that('…and is built at it',
    not pg_temp.noted() and pg_temp.kept()::text = pg_temp.live()::text);
end
$$;

-- A change inside a block that fails is no change: nothing noted, nothing to
-- build, and the copy as it was.
do $$
declare
  before jsonb := pg_temp.kept();
begin
  begin
    update meganet.doc_meta set description = description || ' (checked)';
    raise exception using errcode = 'MNRLB';
  exception when sqlstate 'MNRLB' then null;
  end;
  perform pg_temp.check_that('a change rolled back to a savepoint leaves nothing noted, and the copy as it was',
    not pg_temp.noted() and pg_temp.kept() = before and meganet.stations_doc() = before);
end
$$;

-- ── 5. The watch ─────────────────────────────────────────────────────────────
-- A table that lost its trigger gets it back, one that is not read loses it,
-- and the copy is built — what a migration that changes the views relies on.

do $$
declare
  n integer;
begin
  drop trigger if exists stations_doc_touch on meganet.station_crossing;
  create trigger stations_doc_touch after insert on meganet.app_meta
    for each statement execute function meganet.stations_doc_touch();
  update meganet.doc_meta set description = description;  -- noted, not built
  n := meganet.stations_doc_watch();
  perform pg_temp.check_that('stations_doc_watch() puts back a trigger that was dropped',
    exists (select 1 from pg_catalog.pg_trigger g
             where g.tgrelid = 'meganet.station_crossing'::regclass and g.tgname = 'stations_doc_touch'));
  perform pg_temp.check_that('…takes one off a table the document does not read',
    not exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = 'meganet.app_meta'::regclass and g.tgname = 'stations_doc_touch'));
  perform pg_temp.check_that('…counts every table it watches',
    n = (select count(*) from meganet.stations_doc_reads()), n::text);
  perform pg_temp.check_that('…and builds the copy',
    pg_temp.kept()::text = pg_temp.live()::text);
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
