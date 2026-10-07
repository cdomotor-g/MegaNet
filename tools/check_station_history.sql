-- check_station_history.sql — Prove the station history (0056) against a real
-- database: what a write records and what it does not, whom a change is
-- pinned on, who may read the log, and the two ways back — a field through
-- save_station(), a deleted station through restore_station() — each held to
-- the checks an ordinary save is.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_history.sql
--
-- Every check below is one claim the head of 0056_station_history.sql makes.
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database: nothing it writes survives — the stations it
-- makes, edits, deletes, restores and drops, the change rows all of that
-- writes, and the editor it signs up. It needs a role meganet.is_editor() says
-- yes to — a direct psql connection, or one holding the service key — and
-- prints a row per check, exiting non-zero if any failed. CI runs it in the
-- db-checks job after every migration has been applied from zero and
-- stations.json loaded (.github/workflows/web-smoke.yml).
--
-- What it deliberately does not check: the History panel and the Admin tab's
-- Deleted stations — what they draw, and that a Restore there is the save
-- this proves — which are test/stationhistory.mjs's.

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

-- Run one statement as another role with the claims a request would carry, and
-- say how it ended — 'ok', or the SQLSTATE and the DETAIL line — then roll it
-- back (check_proposed_stations.sql's helper).
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
  v_det   text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_det = pg_exception_detail;
      return v_state || coalesce('/' || nullif(v_det, ''), '');
  end;
end;
$$;

-- The same, answering with the one value the statement returns — what a role
-- can see, rather than whether it may run it — or the SQLSTATE.
create or replace function pg_temp.value_as(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return v;
    when others then return 'ERR ' || sqlstate;
  end;
end;
$$;

-- The same as the connection running the script, kept: the SQLSTATE and the
-- message, or 'ok'.
create or replace function pg_temp.refusal_of(p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
  v_msg   text;
  v_det   text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
  return v_state || coalesce('/' || nullif(v_det, ''), '') || ' ' || v_msg;
end;
$$;

create or replace function pg_temp.stamp(p_id text)
returns timestamptz language sql as $$
  select updated_at from meganet.station where id = p_id;
$$;

create or replace function pg_temp.doc_of(p_id text)
returns jsonb language sql as $$
  select doc from meganet.station_json where id = p_id;
$$;

-- The station's change rows, oldest first, and how many.
create or replace function pg_temp.changes(p_id text)
returns setof meganet.station_change language sql as $$
  select * from meganet.station_change where station_id = p_id order by id;
$$;
create or replace function pg_temp.n_changes(p_id text)
returns integer language sql as $$
  select count(*)::integer from meganet.station_change where station_id = p_id;
$$;
create or replace function pg_temp.last_change(p_id text)
returns meganet.station_change language sql as $$
  select * from meganet.station_change where station_id = p_id order by id desc limit 1;
$$;

-- The editor's claims, for a write that is kept (as_role rolls its statement
-- back; this does not), and none at all — the direct connection.
create or replace function pg_temp.as_editor()
returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"history-editor@example.test","sub":"00000000-0000-4000-8000-0000000c5601"}', true);
$$;
create or replace function pg_temp.as_owner()
returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', '', true);
$$;

-- An editor's save of the database's own copy of a station with some keys
-- changed — what the History panel does to put a field back
-- (stationSaveFields(), station-editor.js): a key given null is taken out.
create or replace function pg_temp.editor_saves(p_id text, p_patch jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  d jsonb := pg_temp.doc_of(p_id);
  k text;
begin
  perform pg_temp.as_editor();
  for k in select jsonb_object_keys(p_patch) loop
    if p_patch -> k = 'null'::jsonb then d := d - k; else d := d || jsonb_build_object(k, p_patch -> k); end if;
  end loop;
  return meganet.save_station(d, pg_temp.stamp(p_id));
end;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- A radio system and a radio network of the check's own, seven stations in the
-- Tasman Sea, and an editor signed up the way the signup triggers (0005)
-- provision one. The stations are made as a loader makes them — stamped — so
-- the first thing each of them has is a `created` row.

select pg_temp.as_owner();

insert into meganet.rm_system (id, ord, name)
values (-956, -956, 'check_station_history placeholder')
on conflict (id) do nothing;

insert into meganet.radio_network (id, ord, name)
values ('_check_hist_net', -956, 'check_station_history network')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles,
                             radio_network_ids, alert2_station_id, notes, updated_by) values
  ('_check_hist_a', -956, 'Check History Creek', '998561', -956, -31.71, 161.21, '{field}', '{}', null, '', 'check_station_history.sql'),
  ('_check_hist_b', -955, 'Check History Number', '998562', -956, -31.72, 161.22, '{field}', '{}', null, '', 'check_station_history.sql'),
  ('_check_hist_c', -954, 'Check History Relay', '998563', -956, -31.73, 161.23, '{field}', '{}', 64561, '', 'check_station_history.sql'),
  ('_check_hist_d', -953, 'Check History Network', '998564', -956, -31.74, 161.24, '{field}', '{_check_hist_net}', null, '', 'check_station_history.sql'),
  ('_check_hist_f', -952, 'Check History Gauge', '998565', -956, -31.75, 161.25, '{field}', '{}', null, '', 'check_station_history.sql'),
  ('_check_hist_x', -950, 'Check History Dropped', '998567', -956, -31.77, 161.27, '{field}', '{}', null, 'kept in the log', 'check_station_history.sql')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles,
                             flood_peaks_from, notes, updated_by) values
  ('_check_hist_e', -951, 'Check History Borrower', '998566', -956, -31.76, 161.26, '{field}', '_check_hist_f', '', 'check_station_history.sql')
on conflict (id) do nothing;

insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, updated_by)
values ('_check_hist_a', '_check_hist_a:6561', 'Rain', 0, 6561, 'check_station_history.sql')
on conflict do nothing;

insert into meganet.editor_allow (entry, note) values
  ('history-editor@example.test', 'check_station_history — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c5601', 'history-editor@example.test')
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000c5609"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"history-editor@example.test","sub":"00000000-0000-4000-8000-0000000c5601"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.value_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.value_as(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 56',
    (select value::integer from meganet.app_meta where key = 'schema_version') >= 56);
  perform pg_temp.check_that('meganet.station_change exists, with RLS on',
    (select relrowsecurity from pg_catalog.pg_class where oid = to_regclass('meganet.station_change')));
  perform pg_temp.check_that('…and one policy: select, for authenticated, through is_editor()',
    (select count(*) = 1 and bool_and(p.cmd = 'SELECT' and p.qual like '%is_editor()%'
                                      and p.roles = array['authenticated']::name[])
       from pg_catalog.pg_policies p
      where p.schemaname = 'meganet' and p.tablename = 'station_change'));
  perform pg_temp.check_that('three statement-level AFTER triggers on meganet.station write it',
    (select count(*) = 3
       from pg_catalog.pg_trigger t
      where t.tgrelid = 'meganet.station'::regclass and not t.tgisinternal
        and t.tgfoid = 'meganet.station_change_log()'::regprocedure
        and (t.tgtype & 1) = 0            -- not FOR EACH ROW
        and (t.tgtype & 2) = 0));         -- not BEFORE
  perform pg_temp.check_that('the trigger function is security definer, and nobody may call it',
    (select prosecdef from pg_catalog.pg_proc where oid = 'meganet.station_change_log()'::regprocedure)
    and not has_function_privilege('public', 'meganet.station_change_log()', 'execute'));
  perform pg_temp.check_that('restore_station() exists, security definer, not executable by public or anon',
    (select prosecdef from pg_catalog.pg_proc where oid = 'meganet.restore_station(text, timestamptz)'::regprocedure)
    and not has_function_privilege('public', 'meganet.restore_station(text, timestamptz)', 'execute')
    and not has_function_privilege('anon', 'meganet.restore_station(text, timestamptz)', 'execute'));
  perform pg_temp.check_that('anon holds no privilege on the log',
    not has_table_privilege('anon', 'meganet.station_change', 'select')
    and not has_table_privilege('anon', 'meganet.station_change', 'insert'));
  perform pg_temp.check_that('authenticated may select it and write nothing',
    has_table_privilege('authenticated', 'meganet.station_change', 'select')
    and not has_table_privilege('authenticated', 'meganet.station_change', 'insert')
    and not has_table_privilege('authenticated', 'meganet.station_change', 'update')
    and not has_table_privilege('authenticated', 'meganet.station_change', 'delete'));
end
$$;

-- ── 2. What a write records ──────────────────────────────────────────────────

do $$
declare
  c meganet.station_change;
  n integer;
  r jsonb;
begin
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('a station made by a loader has one `created` row, with no values, pinned on its stamp',
    pg_temp.n_changes('_check_hist_a') = 1 and c.kind = 'created' and c.before is null and c.after is null
      and c.changed_by = 'check_station_history.sql', coalesce(row_to_json(c)::text, '<none>'));

  n := pg_temp.n_changes('_check_hist_a');
  perform pg_temp.editor_saves('_check_hist_a');
  perform pg_temp.check_that('an editor''s save that changes nothing writes nothing — though it restamps the station',
    pg_temp.n_changes('_check_hist_a') = n
      and (select updated_by from meganet.station where id = '_check_hist_a') = 'history-editor@example.test');

  r := pg_temp.editor_saves('_check_hist_a', '{"name": "Check History Creek Renamed", "notes": "moved upstream"}');
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('an editor''s save that changes two fields writes one `edited` row',
    pg_temp.n_changes('_check_hist_a') = n + 1 and c.kind = 'edited', coalesce(row_to_json(c)::text, '<none>'));
  perform pg_temp.check_that('…holding those two fields and nothing else, as they were and as they became',
    c.before = '{"name": "Check History Creek", "notes": ""}'::jsonb
      and c.after = '{"name": "Check History Creek Renamed", "notes": "moved upstream"}'::jsonb,
    row_to_json(c)::text);
  perform pg_temp.check_that('…pinned on the editor, as updated_by is',
    c.changed_by = 'history-editor@example.test' and c.changed_by = r ->> 'updated_by', c.changed_by);
  perform pg_temp.check_that('…at the instant the station was stamped',
    c.changed_at = pg_temp.stamp('_check_hist_a'));

  n := pg_temp.n_changes('_check_hist_a');
  perform pg_temp.editor_saves('_check_hist_a', '{"lat": -31.7100, "elevation_ahd": 12.50}');
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('the same latitude with more digits is not a change; a new elevation is, alone',
    pg_temp.n_changes('_check_hist_a') = n + 1 and c.before = '{"elevation_ahd": null}'::jsonb
      and (c.after ->> 'elevation_ahd')::numeric = 12.5,
    coalesce(row_to_json(c)::text, '<none>'));

  perform pg_temp.as_owner();
  n := pg_temp.n_changes('_check_hist_a');
  update meganet.station set ord = ord - 1000 where id = '_check_hist_a';
  update meganet.station set updated_by = 'somebody else' where id = '_check_hist_a';
  perform pg_temp.check_that('moving the station''s place in the document, or only its stamp, writes nothing',
    pg_temp.n_changes('_check_hist_a') = n);
end
$$;

-- ── 3. Whom a change is pinned on ────────────────────────────────────────────

do $$
declare
  c meganet.station_change;
begin
  perform pg_temp.as_owner();
  -- A hand-run UPDATE that leaves updated_by alone: the station's stamp still
  -- names the editor, and the change must not.
  update meganet.station set notes = 'a hand-run note' where id = '_check_hist_a';
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('a direct UPDATE that leaves updated_by alone is pinned on the connection, not on the last stamp',
    c.changed_by = meganet.actor() and c.changed_by <> 'somebody else'
      and c.after = '{"notes": "a hand-run note"}'::jsonb, coalesce(row_to_json(c)::text, '<none>'));

  update meganet.station set notes = 'a loader''s note', updated_by = 'a_loader_tag' where id = '_check_hist_a';
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('a write that stamps a new updated_by is pinned on that stamp — a loader names itself',
    c.changed_by = 'a_loader_tag', coalesce(row_to_json(c)::text, '<none>'));

  update meganet.station set notes = '' where id = '_check_hist_a';
end
$$;

-- ── 4. Delete, and the way back ──────────────────────────────────────────────

do $$
declare
  c   meganet.station_change;
  n   integer;
  r   jsonb;
  at0 timestamptz;
begin
  perform pg_temp.as_editor();
  perform meganet.delete_station('_check_hist_a', pg_temp.stamp('_check_hist_a'));
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('an editor''s delete writes a `deleted` row: deleted_at from nothing to a time',
    c.kind = 'deleted' and c.before = '{"deleted_at": null}'::jsonb
      and (c.after ->> 'deleted_at')::timestamptz is not null
      and c.changed_by = 'history-editor@example.test', coalesce(row_to_json(c)::text, '<none>'));

  at0 := pg_temp.stamp('_check_hist_a');
  perform pg_temp.check_that('anon may not restore a station',
    pg_temp.as_who('anon', format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_a', at0)) like '42501%');
  perform pg_temp.check_that('…nor somebody off the editors list',
    pg_temp.as_who('stranger', format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_a', at0)) like '42501%');
  perform pg_temp.check_that('an editor without the stamp the list was loaded with is refused (PT409)',
    pg_temp.as_who('editor', format('select meganet.restore_station(%L)', '_check_hist_a')) like 'PT409%');
  perform pg_temp.check_that('…and with a stale one (PT409)',
    pg_temp.as_who('editor', format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_a',
                                    at0 - interval '1 second')) like 'PT409%');
  perform pg_temp.check_that('a station there is none of is P0002',
    pg_temp.as_who('editor', format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_nobody', at0)) like 'P0002%');

  n := pg_temp.n_changes('_check_hist_a');
  perform pg_temp.as_editor();
  r := meganet.restore_station('_check_hist_a', at0);
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('with the stamp, an editor restores it: back in the station document',
    (r ->> 'restored')::boolean and pg_temp.doc_of('_check_hist_a') is not null
      and (select deleted_at from meganet.station where id = '_check_hist_a') is null, r::text);
  perform pg_temp.check_that('…with its sensor, which the delete never touched',
    pg_temp.doc_of('_check_hist_a') -> 'sensors' -> 0 ->> 'alert_id' = '6561',
    coalesce(pg_temp.doc_of('_check_hist_a')::text, '<missing>'));
  perform pg_temp.check_that('…answering as save_station() does, with the station and its new stamp',
    r -> 'station' ->> 'id' = '_check_hist_a' and (r ->> 'updated_at')::timestamptz = pg_temp.stamp('_check_hist_a')
      and r ->> 'updated_by' = 'history-editor@example.test', r::text);
  perform pg_temp.check_that('…and one `restored` row, pinned on the editor — the re-save inside it changing nothing',
    pg_temp.n_changes('_check_hist_a') = n + 1 and c.kind = 'restored'
      and c.after = '{"deleted_at": null}'::jsonb and c.changed_by = 'history-editor@example.test',
    coalesce(row_to_json(c)::text, '<none>'));
  r := meganet.restore_station('_check_hist_a', at0);
  perform pg_temp.check_that('restoring a station that is not deleted is success, `already`, and writes nothing',
    (r ->> 'already')::boolean and pg_temp.n_changes('_check_hist_a') = n + 1, r::text);
end
$$;

-- ── 5. A restore is held to an ordinary save's checks ────────────────────────
-- Each of these deleted stations comes back to a register that has moved on
-- while it was away, in a way an ordinary save would refuse: its station
-- number given to another station, its ALERT2 address likewise, its radio
-- network gone (0053's guard), the station it takes its floods from deleted
-- (save_station()'s own sentence). Each is refused in words, and each stays
-- deleted with nothing written.

do $$
declare
  v text;
  n integer;
begin
  perform pg_temp.as_editor();
  perform meganet.delete_station(s, pg_temp.stamp(s))
     from unnest(array['_check_hist_b', '_check_hist_c', '_check_hist_d', '_check_hist_e', '_check_hist_f']) s;

  perform pg_temp.as_owner();
  -- While they are away: the number and the address go to other stations, the
  -- network is withdrawn, and the gauge stays deleted.
  update meganet.station set station_number = '998562' where id = '_check_hist_x';
  update meganet.station set alert2_station_id = 64561 where id = '_check_hist_a';
  delete from meganet.radio_network where id = '_check_hist_net';

  perform pg_temp.as_editor();
  v := pg_temp.refusal_of(format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_b', pg_temp.stamp('_check_hist_b')));
  perform pg_temp.check_that('its station number now another station''s: refused (23505), naming that station',
    v like '23505%' and v like '%998562%' and v like '%Check History Dropped (_check_hist_x)%', v);
  v := pg_temp.refusal_of(format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_c', pg_temp.stamp('_check_hist_c')));
  perform pg_temp.check_that('its ALERT2 address now another station''s: refused (23505), naming that station',
    v like '23505%' and v like '%64561%' and v like '%(_check_hist_a)%', v);
  v := pg_temp.refusal_of(format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_d', pg_temp.stamp('_check_hist_d')));
  perform pg_temp.check_that('its radio network gone: refused by 0053''s guard (23503)',
    v like '23503%' and v like '%_check_hist_net%', v);
  v := pg_temp.refusal_of(format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_e', pg_temp.stamp('_check_hist_e')));
  perform pg_temp.check_that('the station it takes its floods from deleted: refused by save_station() (22023)',
    v like '22023%' and v like '%_check_hist_f%', v);
  perform pg_temp.check_that('…and all four are still deleted, with no `restored` row among them',
    (select count(*) = 4 from meganet.station
      where id in ('_check_hist_b', '_check_hist_c', '_check_hist_d', '_check_hist_e') and deleted_at is not null)
    and not exists (select 1 from meganet.station_change
                     where station_id in ('_check_hist_b', '_check_hist_c', '_check_hist_d', '_check_hist_e')
                       and kind = 'restored'));

  -- Restoring the gauge first is the way out for the borrower.
  perform meganet.restore_station('_check_hist_f', pg_temp.stamp('_check_hist_f'));
  v := pg_temp.refusal_of(format('select meganet.restore_station(%L, %L::timestamptz)', '_check_hist_e', pg_temp.stamp('_check_hist_e')));
  perform pg_temp.check_that('…until the gauge it borrows from is restored first: then it comes back',
    v = 'ok' and pg_temp.doc_of('_check_hist_e') ->> 'flood_peaks_from' = '_check_hist_f', v);
end
$$;

-- ── 6. A field goes back through save_station() ──────────────────────────────
-- What the History panel does: the database's copy of the station, the
-- earlier value from a change's `before`, the stamp it read — and the restore
-- is itself a change, the other way round, pinned on whoever pressed it.

do $$
declare
  c    meganet.station_change;
  was  jsonb;
  v    text;
begin
  select before into was from meganet.station_change
   where station_id = '_check_hist_a' and kind = 'edited' and before ? 'name'
   order by id limit 1;
  perform pg_temp.editor_saves('_check_hist_a', jsonb_build_object('name', was -> 'name'));
  c := pg_temp.last_change('_check_hist_a');
  perform pg_temp.check_that('putting the old name back is one `edited` row, the rename the other way round',
    c.kind = 'edited' and c.before = '{"name": "Check History Creek Renamed"}'::jsonb
      and c.after = '{"name": "Check History Creek"}'::jsonb and c.changed_by = 'history-editor@example.test',
    coalesce(row_to_json(c)::text, '<none>'));

  perform pg_temp.editor_saves('_check_hist_a', '{"elevation_ahd": null}');
  perform pg_temp.check_that('putting back "not recorded" takes the key out, and the column is null again',
    (select elevation_ahd from meganet.station where id = '_check_hist_a') is null
      and (pg_temp.last_change('_check_hist_a')).after = '{"elevation_ahd": null}'::jsonb);

  -- An established station that was once a proposal: putting `proposed` back
  -- is an administrator's (0039), from the History panel as from the form.
  perform pg_temp.as_owner();
  update meganet.station set proposed = true, station_type = 'auto_rain_gauge', proposed_year = 2026
   where id = '_check_hist_x';
  update meganet.station set proposed = false where id = '_check_hist_x';
  perform pg_temp.check_that('…and an establishment is in the log as proposed true → false',
    (pg_temp.last_change('_check_hist_x')).before = '{"proposed": true}'::jsonb);
  v := pg_temp.as_who('editor', format('select meganet.save_station(%L::jsonb, %L::timestamptz)',
         pg_temp.doc_of('_check_hist_x') || '{"proposed": true}'::jsonb, pg_temp.stamp('_check_hist_x')));
  perform pg_temp.check_that('putting `proposed` back is refused an editor as any save of it is (42501/administrator)',
    v = '42501/administrator', v);
end
$$;

-- ── 7. The loaders ───────────────────────────────────────────────────────────
-- The whole register back through load_stations_doc(), which rewrites `ord` for
-- every station after the check's own (they went in at the front): with one
-- station renamed, one row naming the loader and none for the thousands it
-- only re-placed; again, nothing; without one station, that station dropped
-- for real — and its history kept.

do $$
declare
  d    jsonb;
  n    integer;
  c    meganet.station_change;
  kept integer;
begin
  perform pg_temp.as_owner();
  -- A sync drops a soft-deleted station for real, since the document does not
  -- carry it (db/README.md, Writing). That is the loader's business, not this
  -- check's: the deleted ones — this check's three, and on the live database
  -- whatever else is deleted — are set aside for it, inside the transaction.
  -- The network section 5 withdrew comes back first, or 0053's guard refuses
  -- any write at all to the station still naming it.
  insert into meganet.radio_network (id, ord, name)
  values ('_check_hist_net', -956, 'check_station_history network')
  on conflict (id) do nothing;
  update meganet.station set document_managed = false where deleted_at is not null and document_managed;

  d := meganet.stations_doc();
  d := jsonb_set(d, '{stations}',
    (select jsonb_agg(case when x.s ->> 'id' = '_check_hist_e'
                           then x.s || '{"name": "Check History Borrower, renamed by a loader"}'::jsonb else x.s end
                      order by x.o)
       from jsonb_array_elements(d -> 'stations') with ordinality x(s, o)));
  n := (select count(*) from meganet.station_change);
  perform meganet.load_stations_doc(d);
  c := pg_temp.last_change('_check_hist_e');
  perform pg_temp.check_that('load_stations_doc() with one station renamed: one row for it, naming the loader, holding the name alone',
    c.kind = 'edited' and c.changed_by = 'load_stations_doc'
      and c.after = '{"name": "Check History Borrower, renamed by a loader"}'::jsonb,
    coalesce(row_to_json(c)::text, '<none>'));
  perform pg_temp.check_that('…and that is the only row — every station it only moved in the document has none',
    (select count(*) from meganet.station_change) = n + 1, ((select count(*) from meganet.station_change) - n)::text || ' rows');

  n := (select count(*) from meganet.station_change);
  perform meganet.load_stations_doc(d);
  perform pg_temp.check_that('the same document again writes nothing',
    (select count(*) from meganet.station_change) = n, ((select count(*) from meganet.station_change) - n)::text || ' rows');

  d := jsonb_set(d, '{stations}',
    (select jsonb_agg(case when x.s ->> 'id' = '_check_hist_e'
                           then x.s || '{"name": "Check History Borrower, renamed again"}'::jsonb else x.s end
                      order by x.o)
       from jsonb_array_elements(d -> 'stations') with ordinality x(s, o)
      where x.s ->> 'id' <> '_check_hist_x'));
  kept := pg_temp.n_changes('_check_hist_x');
  n := (select count(*) from meganet.station_change);
  perform meganet.load_stations_doc(d);
  c := pg_temp.last_change('_check_hist_e');
  perform pg_temp.check_that('a second rename by the loader, of a station it stamped last time, is pinned on the connection — a stamp that did not move is not believed',
    c.kind = 'edited' and c.changed_by = meganet.actor() and c.changed_by <> 'load_stations_doc'
      and c.after = '{"name": "Check History Borrower, renamed again"}'::jsonb,
    coalesce(row_to_json(c)::text, '<none>'));
  c := pg_temp.last_change('_check_hist_x');
  perform pg_temp.check_that('without a station, the sync drops it for real: one `removed` row holding the whole row',
    not exists (select 1 from meganet.station where id = '_check_hist_x')
      and c.kind = 'removed' and c.after is null
      and c.before ->> 'notes' = 'kept in the log' and c.before ->> 'station_number' = '998562'
      and not (c.before ? 'updated_at') and not (c.before ? 'ord'),
    coalesce(row_to_json(c)::text, '<none>'));
  perform pg_temp.check_that('…its history kept: the station is gone, every row about it is not',
    pg_temp.n_changes('_check_hist_x') = kept + 1);
  perform pg_temp.check_that('…and those two are all that sync wrote',
    (select count(*) from meganet.station_change) = n + 2, ((select count(*) from meganet.station_change) - n)::text || ' rows');
end
$$;

-- ── 8. Who may read it ───────────────────────────────────────────────────────

do $$
declare
  v text;
begin
  v := pg_temp.value_who('anon', $q$select count(*)::text from meganet.station_change$q$);
  perform pg_temp.check_that('anon is refused the log outright (42501)', v = 'ERR 42501', v);
  v := pg_temp.value_who('stranger', $q$select count(*)::text from meganet.station_change where station_id like '\_check\_hist\_%'$q$);
  perform pg_temp.check_that('somebody signed in but off the editors list sees no row of it', v = '0', v);
  v := pg_temp.value_who('editor', $q$select count(*)::text from meganet.station_change where station_id like '\_check\_hist\_%'$q$);
  perform pg_temp.check_that('an editor sees every row of it',
    v = (select count(*)::text from meganet.station_change where station_id like '\_check\_hist\_%'), v);
  perform pg_temp.check_that('…and may write none of it — not even an editor (42501)',
    pg_temp.as_who('editor', $q$insert into meganet.station_change (station_id, kind) values ('_check_hist_a', 'created')$q$) like '42501%'
    and pg_temp.as_who('editor', $q$delete from meganet.station_change where station_id = '_check_hist_a'$q$) like '42501%'
    and pg_temp.as_who('editor', $q$update meganet.station_change set changed_by = 'me' where station_id = '_check_hist_a'$q$) like '42501%');
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 200) end as detail
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
