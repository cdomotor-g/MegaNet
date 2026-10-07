-- 0056_station_history.sql — Who changed a station, what they changed, and the
-- way back: a change log on meganet.station kept by a trigger, readable by
-- editors, and an un-delete that goes through the editor's own save.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0056_station_history.sql
--
-- Why this file exists
-- ────────────────────
-- Station writes have stamped updated_by since 0004, and a delete has been soft
-- since then too. Neither is a history. The stamp says who touched a station
-- last and nothing about what they changed, or what it said before; and a
-- deleted station came back only by somebody with SQL access running the line
-- 0004 left in a comment. Issue #219 asks for the record and the way back:
-- who changed what and when, a field-level difference, and putting back an
-- earlier value — or a deleted station — without SQL.
--
-- What is recorded
-- ────────────────
-- meganet.station_change, one row per station per statement that changed it:
--
--   station_id   the station. No foreign key, on purpose: the log has to
--                outlive the row it describes, and a sync that drops a station
--                for real (load_stations_doc(), the import tool) is exactly
--                the change somebody will come looking for afterwards.
--   changed_at   when — the transaction's now(), the same instant the write
--                stamped into updated_at.
--   changed_by   who: the updated_by the write stamped, where it stamped a new
--                one, and otherwise meganet.actor() — the same identity a
--                station write has recorded since 0004 (the email on the
--                request's token, or the database role for a direct
--                connection). The order matters. A loader names itself in the
--                stamp ('load_stations_doc', 'import_stations_json.py'), which
--                says more than "postgres"; but a hand-run UPDATE that leaves
--                updated_by alone must not be pinned on whoever saved the
--                station last, so a stamp that did not move is not believed.
--   kind         created, edited, deleted (deleted_at went from null to a
--                time), restored (the other way), or removed (the row itself
--                was deleted — by a sync or by hand, never by the editor,
--                whose delete is soft).
--   before       the changed fields as they were, by column name.
--   after        …and as they became.
--
-- **Only what changed.** A field is in before/after only when its value moved,
-- compared as jsonb — so 94.50 written over 94.5 is the same number and not a
-- change. updated_at, updated_by and ord are never compared: the first two are
-- the bookkeeping this table replaces, and ord is the station's place in the
-- document, which moves for every station after an insertion in the middle of
-- it and says nothing about the station. **A write that changes nothing writes
-- no row** — and save_station() restamps every station it saves, so that is
-- the rule that keeps the table to what people actually did.
--
-- **A creation records no values**, and neither half is needed: the station as
-- it was created is the station now with every later change's `before` put
-- back, which is how the History panel works out any earlier version. A removal
-- records the whole row as `before`, because after it there is no "now" to work
-- back from.
--
-- **Every column, including the next one.** The trigger compares the rows as
-- jsonb rather than column by column, so a column a later migration adds to
-- meganet.station is in the history from the moment it exists, with nothing to
-- restate here — this is the one station object that does not have to be
-- copied forward by every station migration, as station_json, save_station()
-- and load_stations_doc() are. What a later migration does have to respect: a
-- new *bookkeeping* column (an audit stamp, a cache) belongs in the ignored
-- list in station_change_log() below, or every write that touches it is a
-- change; and a bulk UPDATE of meganet.station in a migration is a change to
-- every station it moves, recorded as such — which is right, and worth
-- knowing before writing one.
--
-- **Only the station's own fields.** Its sensors, its repeater and that
-- repeater's ranges, and the Bureau's lists (0031–0033) are rows of their own
-- tables, replaced wholesale by save_station() on every save that sends them —
-- a statement-level log of those would record a delete and an identical insert
-- for every save, and netting a whole transaction out is a design of its own.
-- What the station row carries of them is here: alert_ids (derived from the
-- sensors) and the roles. The History panel says so.
--
-- What it costs
-- ─────────────
-- One statement-level trigger per verb, reading the transition tables once —
-- 0037's pattern — so a loader that writes 4,873 stations in one statement
-- pays one INSERT … SELECT, not 4,873 trigger calls. A re-run of
-- load_stations_doc() or tools/import_stations_json.py over an unchanged
-- document writes nothing (both skip a row whose data has not moved, so the
-- trigger sees no rows); over a newer snapshot, a row per station that moved,
-- holding what moved. A full import into an empty database writes one
-- `created` row per station and no values: 4,871 rows on CI's database
-- (elpro_test and bateson_test are made by migrations before this one), about
-- 1 MB, half of it the index. An edit is one row of a few hundred bytes.
-- Applied to a database that already has its stations, this file writes no
-- row at all: history starts at the first change after it.
--
-- Who may read it
-- ───────────────
-- Editors (meganet.is_editor()), under RLS — the same people who may make the
-- changes it records. Not anon: it names people, and the agent API
-- (worker/api.js) does not list it and is not to. Nothing is granted a write
-- verb; the only writer is the trigger.
--
-- The way back
-- ────────────
-- **A field, or an earlier version, goes back through save_station()** — the
-- History panel (station-history.js) reads the database's current copy of the
-- station, puts the earlier values in, and saves it with the stamp it read,
-- exactly as the twin and the move-pin mode save a field (stationSaveFields(),
-- station-editor.js). So a value that would be refused if typed is refused when
-- restored — 0053's guard, the proposal rules (0039), every sentence
-- save_station() asks — and the restore is itself a change in this log,
-- attributed to whoever pressed it. Nothing here writes a station's fields.
--
-- **A deleted station comes back through meganet.restore_station()**, the one
-- function this file adds that writes, and the narrowest that would do: editors
-- only, the stamp the list was loaded with or PT409, and no field set but
-- deleted_at (and the stamp). It clears that — which is all a deleted station
-- needs, since its sensors, repeater and lists were never touched — and hands
-- the station as it now stands to save_station(), so the restored station is
-- held to every check an ordinary save is: the unique station number and
-- ALERT2 address among live stations (said in a sentence naming the station
-- that holds it now), a network or a station it names that has gone since,
-- and whatever a later migration adds to save_station(). One transaction:
-- refused anywhere, it stays deleted. It could not simply be save_station()
-- with the document, because a deleted station has no document —
-- meganet.station_json is what filters it out, which is what makes the soft
-- delete work everywhere at once.

-- ── The log ──────────────────────────────────────────────────────────────────

create table if not exists meganet.station_change (
  id          bigint      generated always as identity primary key,
  station_id  text        not null,
  changed_at  timestamptz not null default pg_catalog.now(),
  changed_by  text,
  kind        text        not null,
  before      jsonb,
  after       jsonb,

  constraint station_change_kind check (kind in ('created', 'edited', 'deleted', 'restored', 'removed')),
  constraint station_change_shape check (
    (kind = 'created' and before is null and after is null)
    or (kind = 'removed' and before is not null and after is null)
    or (kind in ('edited', 'deleted', 'restored') and before is not null and after is not null))
);

comment on table meganet.station_change is
  'One row per station per statement that changed it (0056): who, when, what kind, and the fields that moved as they were and as they became, by column name. Written only by the trigger station_change_log() on meganet.station; readable by editors only. See db/README.md, Station history.';
comment on column meganet.station_change.station_id is
  'The station. No foreign key: the log outlives a row a sync removes.';
comment on column meganet.station_change.changed_by is
  'The updated_by the write stamped, where it stamped a new one; otherwise meganet.actor() — the token''s email, or the database role.';
comment on column meganet.station_change.before is
  'The changed fields as they were, keyed by column. Null for created; the whole row for removed. updated_at, updated_by and ord are never compared.';
comment on column meganet.station_change.after is
  'The changed fields as they became. Null for created and removed — a creation''s values are the station now with every later change''s before put back.';

create index if not exists station_change_station_idx
  on meganet.station_change (station_id, changed_at desc, id desc);

alter table meganet.station_change enable row level security;

drop policy if exists station_change_read_editors on meganet.station_change;
create policy station_change_read_editors on meganet.station_change
  for select to authenticated
  using (meganet.is_editor());

-- ── The trigger ──────────────────────────────────────────────────────────────
-- One function for the three verbs, branching on tg_op the way 0037's
-- flood_peak_station_changed() does: a branch only names the transition table
-- its verb has. `security definer` because the writer is the trigger, never the
-- caller — nobody a browser can reach holds INSERT here, and a direct UPDATE by
-- some later grant must still be logged.

create or replace function meganet.station_change_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  text := meganet.actor();
  -- Never compared. See the head of this file — a new bookkeeping column on
  -- meganet.station is added here, in the migration that adds it.
  v_ignore text[] := array['updated_at', 'updated_by', 'ord'];
begin
  if tg_op = 'INSERT' then
    insert into meganet.station_change (station_id, changed_by, kind)
    select n.id, coalesce(n.updated_by, v_actor), 'created'
      from new_rows n;

  elsif tg_op = 'UPDATE' then
    insert into meganet.station_change (station_id, changed_by, kind, before, after)
    select d.id,
           case when d.new_by is not null and d.new_by is distinct from d.old_by
                then d.new_by else v_actor end,
           case when d.before ? 'deleted_at' and d.before -> 'deleted_at' = 'null'::jsonb then 'deleted'
                when d.before ? 'deleted_at' and d.after -> 'deleted_at' = 'null'::jsonb then 'restored'
                else 'edited' end,
           d.before, d.after
      from (
        select n.id, o.updated_by as old_by, n.updated_by as new_by,
               (select pg_catalog.jsonb_object_agg(e.key, e.value)
                  from pg_catalog.jsonb_each(x.was - v_ignore) e
                 where e.value is distinct from x.now -> e.key) as before,
               (select pg_catalog.jsonb_object_agg(e.key, e.value)
                  from pg_catalog.jsonb_each(x.now - v_ignore) e
                 where e.value is distinct from x.was -> e.key) as after
          from new_rows n
          join old_rows o on o.id = n.id
          cross join lateral (select pg_catalog.to_jsonb(o) as was, pg_catalog.to_jsonb(n) as now) x
      ) d
     where d.before is not null;

  else
    insert into meganet.station_change (station_id, changed_by, kind, before)
    select o.id, v_actor, 'removed', pg_catalog.to_jsonb(o) - v_ignore
      from old_rows o;
  end if;

  return null;
end
$$;

comment on function meganet.station_change_log() is
  'AFTER INSERT/UPDATE/DELETE, per statement, on meganet.station: writes meganet.station_change — a row per station the statement changed, with only the fields that moved (0056).';

revoke all on function meganet.station_change_log() from public;

drop trigger if exists station_change_ins on meganet.station;
drop trigger if exists station_change_upd on meganet.station;
drop trigger if exists station_change_del on meganet.station;
create trigger station_change_ins after insert on meganet.station
  referencing new table as new_rows
  for each statement execute function meganet.station_change_log();
create trigger station_change_upd after update on meganet.station
  referencing new table as new_rows old table as old_rows
  for each statement execute function meganet.station_change_log();
create trigger station_change_del after delete on meganet.station
  referencing old table as old_rows
  for each statement execute function meganet.station_change_log();

-- ── Restoring a deleted station ──────────────────────────────────────────────
-- delete_station()'s mirror, on delete_station()'s terms: editors, the stamp
-- the list was loaded with, and a station that is not deleted answered as
-- success with `already`, so a second press is not an error to interpret.

create or replace function meganet.restore_station(
         p_id text,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev    timestamptz;
  v_deleted timestamptz;
  v_number  text;
  v_a2      integer;
  v_con     text;
  v_holder  text;
  v_doc     jsonb;
  v_stamp   timestamptz;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write to the station list'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see #B8';
  end if;

  select updated_at, deleted_at, station_number, alert2_station_id
    into v_prev, v_deleted, v_number, v_a2
    from meganet.station where id = p_id for update;

  if not found then
    raise exception 'no station "%"', p_id using errcode = 'P0002';
  end if;

  if v_deleted is null then
    return pg_catalog.jsonb_build_object(
             'id',         p_id,
             'already',    true,
             'updated_at', v_prev,
             'station',    (select j.doc from meganet.station_json j where j.id = p_id));
  end if;

  if p_expected_updated_at is null then
    raise exception 'this list did not load station "%" from the database, so it will not restore it', p_id
      using errcode = 'PT409',
            hint    = 'reload the list of deleted stations and press Restore again';
  end if;
  if v_prev is distinct from p_expected_updated_at then
    raise exception 'station "%" was changed in the database at %, after the list was loaded', p_id, v_prev
      using errcode = 'PT409',
            hint    = 'reload the list of deleted stations to see where it stands now';
  end if;

  -- Back among the live stations. The two partial unique indexes are what can
  -- refuse this — a number or an ALERT2 address given to another station while
  -- this one was away — and the person pressing Restore is owed the name of the
  -- station that has it, not the index's.
  begin
    update meganet.station
       set deleted_at = null, updated_by = meganet.actor()
     where id = p_id;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'station_number_unique_idx' then
      select s.name || ' (' || s.id || ')' into v_holder
        from meganet.station s
       where s.station_number = v_number and s.deleted_at is null and s.id <> p_id
       limit 1;
      raise exception 'station "%" cannot come back holding station number %: % has it now', p_id, v_number, coalesce(v_holder, 'another station')
        using errcode = '23505',
              hint    = 'renumber or delete that station first, then restore this one';
    elsif v_con = 'station_alert2_unique_idx' then
      select s.name || ' (' || s.id || ')' into v_holder
        from meganet.station s
       where s.alert2_station_id = v_a2 and s.deleted_at is null and s.id <> p_id
       limit 1;
      raise exception 'station "%" cannot come back holding ALERT2 address %: % has it now', p_id, v_a2, coalesce(v_holder, 'another station')
        using errcode = '23505',
              hint    = 'clear the address on that station first, then restore this one';
    end if;
    raise exception 'station "%" cannot come back: %', p_id, sqlerrm
      using errcode = '23505';
  end;

  -- And then the editor's own save, of the station exactly as it now stands:
  -- whatever save_station() would refuse of a write, it refuses of this one,
  -- and the whole restore with it.
  select j.doc, j.updated_at into v_doc, v_stamp
    from meganet.station_json j where j.id = p_id;

  return meganet.save_station(v_doc, v_stamp)
         || pg_catalog.jsonb_build_object('restored', true);
end
$$;

comment on function meganet.restore_station(text, timestamptz) is
  'Undo a soft delete (0056): editors only, refuses a stale stamp with PT409, clears deleted_at and then saves the station through meganet.save_station(), so a restore is held to every check an ordinary save is. Returns save_station()''s answer plus restored: true; a station that is not deleted comes back as already: true.';

revoke all on function meganet.restore_station(text, timestamptz) from public;

-- 0004 left the restore as a line of SQL in this comment; it is a function now.
comment on function meganet.delete_station(text, timestamptz) is
  'Soft-delete one station: stamps deleted_at, keeps every row. Restore with meganet.restore_station() — the Admin tab''s Deleted stations panel — since 0056.';

-- ── Grants ───────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.station_change to authenticated, service_role;
  grant execute on function meganet.restore_station(text, timestamptz) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

do $$
begin
  if to_regclass('meganet.station_change') is null
     or to_regprocedure('meganet.station_change_log()') is null
     or to_regprocedure('meganet.restore_station(text, timestamptz)') is null
     or (select count(*) from pg_catalog.pg_trigger
          where tgrelid = 'meganet.station'::regclass
            and tgname in ('station_change_ins', 'station_change_upd', 'station_change_del')) <> 3 then
    raise exception '0056 did not take';
  end if;
end
$$;

-- ── Schema version ────────────────────────────────────────────────────────────
-- Apply after 0055. core.js DB_SCHEMA_VERSION follows (to 56) once it is live;
-- the History panel and the Admin tab's Deleted stations say so in words until
-- then rather than asking the version.
insert into meganet.app_meta (key, value)
values ('schema_version', '56')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
