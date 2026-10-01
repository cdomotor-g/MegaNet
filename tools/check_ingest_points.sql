-- check_ingest_points.sql — Prove 0045, the receivers behind an ingest token
-- saying what and where they are, against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest_points.sql
--
-- The same shape as check_mqtt.sql: one row per claim, a non-zero exit if any
-- fails, and the whole script inside a transaction that rolls back — the token
-- it mints, the reports it files and the reading it posts included — so it is
-- safe against the live database. Run it as a role meganet.is_editor() says yes
-- to: a direct psql connection, or one holding the service key.
--
-- The claim that matters most is the constraint: only a GPS fix may be stored
-- as an exact location. The rest is the door (token-checked, refusing bad
-- reports by name), the history (a change is a new row, a repeat is not), who
-- may read it (editors, never anon), and the end-to-end link — a reading posted
-- through ingest_http() carrying `serial-monitor/<point_id>` as its path.
--
-- ALERT address 64377 is inside the range, far from anything on the network,
-- and rolled back regardless.

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

create or replace function pg_temp.sqlstate_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate;
end;
$$;

-- ── The shape of it ──────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('meganet.ingest_point_report exists',
    to_regclass('meganet.ingest_point_report') is not null);
  perform pg_temp.check_that('meganet.ingest_point_latest exists',
    to_regclass('meganet.ingest_point_latest') is not null);
  perform pg_temp.check_that('meganet.report_ingest_point(jsonb) exists',
    to_regprocedure('meganet.report_ingest_point(jsonb)') is not null);
  perform pg_temp.check_that('row level security is on',
    (select relrowsecurity from pg_class where oid = 'meganet.ingest_point_report'::regclass));
  perform pg_temp.check_that('the one read policy is for editors',
    (select count(*) = 1 and bool_and(qual like '%is_editor()%')
       from pg_policies where schemaname = 'meganet' and tablename = 'ingest_point_report'));
  perform pg_temp.check_that('the latest-report view reads as its caller',
    (select coalesce('security_invoker=true' = any (reloptions), false)
       from pg_class where oid = 'meganet.ingest_point_latest'::regclass));
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('anon role present (Supabase-shaped database)', false, 'run tools/ci/pg_scaffold.sql first');
    return;
  end if;
  perform pg_temp.check_that('anon may not read the reports — a laptop''s location can be somebody''s house',
    not has_table_privilege('anon', 'meganet.ingest_point_report', 'select')
      and not has_table_privilege('anon', 'meganet.ingest_point_latest', 'select'));
  perform pg_temp.check_that('anon may not write them except through the door',
    not has_table_privilege('anon', 'meganet.ingest_point_report', 'insert')
      and not has_table_privilege('anon', 'meganet.ingest_point_report', 'update'));
  perform pg_temp.check_that('anon may call report_ingest_point — the token authorises it',
    has_function_privilege('anon', 'meganet.report_ingest_point(jsonb)', 'execute'));
end
$$;

-- ── A token, and what happens without one ───────────────────────────────────

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_points laptop') ->> 'token') as token;

do $$
declare
  v_tok text := (select token from _tok);
begin
  perform set_config('request.headers', '', true);
  perform pg_temp.check_that('no token is PT401',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"qs-abc123","receiver":"quansheng"}'::jsonb)$q$) = 'PT401');
  perform set_config('request.headers', '{"x-ingest-token":"mgn_made-up-and-invalid"}', true);
  perform pg_temp.check_that('a made-up token is PT401',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"qs-abc123","receiver":"quansheng"}'::jsonb)$q$) = 'PT401');
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', v_tok), true);
end
$$;

-- ── Reports ──────────────────────────────────────────────────────────────────

do $$
declare
  r jsonb;
  r2 jsonb;
  n integer;
  v_station text := (select id from meganet.station order by id limit 1);
begin
  -- A browser location, claimed exact by a careless caller: stored approximate.
  r := meganet.report_ingest_point(jsonb_build_object(
    'point_id', 'QS-abc123', 'name', 'Desk laptop — Quansheng', 'receiver', 'quansheng',
    'detail', jsonb_build_object('firmware', '4d06107f', 'source', 'putty log'),
    'lat', -27.47, 'lon', 153.02, 'accuracy_m', 1800, 'location_source', 'browser',
    'location_approx', false, 'location_note', 'browser geolocation, no GPS'));
  perform pg_temp.check_that('a report answers with the token''s label and the path readings carry',
    r ->> 'label' = '_check_points laptop' and r ->> 'path' = 'serial-monitor/qs-abc123', r::text);
  perform pg_temp.check_that('a browser location is stored approximate even when the caller says exact',
    (select location_approx from meganet.ingest_point_report where id = (r ->> 'id')::bigint)
      and (r ->> 'location_approx')::boolean, r::text);
  perform pg_temp.check_that('point ids are kept in lower case',
    exists (select 1 from meganet.ingest_point_report where point_id = 'qs-abc123'));

  -- The same again: a heartbeat, not a new row.
  r2 := meganet.report_ingest_point(jsonb_build_object(
    'point_id', 'qs-abc123', 'name', 'Desk laptop — Quansheng', 'receiver', 'quansheng',
    'detail', jsonb_build_object('firmware', '4d06107f', 'source', 'putty log'),
    'lat', -27.47, 'lon', 153.02, 'accuracy_m', 1800, 'location_source', 'browser',
    'location_note', 'browser geolocation, no GPS'));
  select count(*) into n from meganet.ingest_point_report where point_id = 'qs-abc123';
  perform pg_temp.check_that('a repeat report moves last_seen_at instead of adding a row',
    (r2 ->> 'repeat')::boolean and r2 ->> 'id' = r ->> 'id' and n = 1, r2::text);

  -- Moved: a new row, and the view shows it.
  r2 := meganet.report_ingest_point(jsonb_build_object(
    'point_id', 'qs-abc123', 'name', 'Desk laptop — Quansheng', 'receiver', 'quansheng',
    'detail', jsonb_build_object('firmware', '4d06107f', 'source', 'putty log'),
    'location_source', 'station', 'host_station_id', v_station, 'lat', -26.5, 'lon', 152.9));
  select count(*) into n from meganet.ingest_point_report where point_id = 'qs-abc123';
  perform pg_temp.check_that('a receiver that moved is a new row',
    not (r2 ->> 'repeat')::boolean and n = 2, r2::text);
  perform pg_temp.check_that('the latest-report view shows where it is now',
    (select location_source = 'station' and host_station_id = v_station and lat = -26.5
       from meganet.ingest_point_latest where point_id = 'qs-abc123'));

  -- GPS, the one source allowed to be exact.
  r := meganet.report_ingest_point(jsonb_build_object(
    'point_id', 'sdr-gps-01', 'receiver', 'rtl-sdr', 'lat', -27.5, 'lon', 152.3, 'accuracy_m', 4,
    'location_source', 'gps', 'location_approx', false));
  perform pg_temp.check_that('a GPS fix may be stored as exact',
    not (r ->> 'location_approx')::boolean
      and not (select location_approx from meganet.ingest_point_report where id = (r ->> 'id')::bigint), r::text);
  perform pg_temp.check_that('a report with no name is named for its point id',
    (select name from meganet.ingest_point_report where id = (r ->> 'id')::bigint) = 'sdr-gps-01');

  -- Nowhere: no coordinates, whatever was sent with it.
  r := meganet.report_ingest_point(jsonb_build_object(
    'point_id', 'ert-unknown', 'receiver', 'ert-a2', 'location_source', 'none', 'lat', 1, 'lon', 2));
  perform pg_temp.check_that('location_source none stores no coordinates',
    (select lat is null and lon is null and location_approx from meganet.ingest_point_report where id = (r ->> 'id')::bigint));

  r := meganet.report_ingest_point(jsonb_build_object(
    'point_id', 'ert-elsewhere', 'receiver', 'ert-a2', 'location_source', 'manual', 'lat', -27, 'lon', 153,
    'host_station_id', '_no_such_station_'));
  perform pg_temp.check_that('a host station that does not exist is dropped, not stored',
    (select host_station_id is null from meganet.ingest_point_report where id = (r ->> 'id')::bigint));
end
$$;

-- ── Refusals, by name ────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('an unknown receiver kind is 22023',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"abc","receiver":"walkie"}'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('a point id with a space or a slash is 22023',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"a b/c","receiver":"ert-a2"}'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('a location without coordinates is 22023',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"abc","receiver":"ert-a2","location_source":"browser"}'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('coordinates off the Earth are 22023',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"abc","receiver":"ert-a2","location_source":"manual","lat":200,"lon":0}'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('an unknown location source is 22023',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"abc","receiver":"ert-a2","location_source":"vibes","lat":1,"lon":1}'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('a report that is not an object is 22023',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('[1,2]'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('an oversized detail is 22023',
    pg_temp.sqlstate_of(format($q$select meganet.report_ingest_point('{"point_id":"abc","receiver":"ert-a2","detail":{"x":"%s"}}'::jsonb)$q$, repeat('y', 5000))) = '22023');

  -- Around the door, as a superuser: the constraint itself holds the line.
  perform pg_temp.check_that('the table itself refuses an approximate source stored as exact',
    pg_temp.sqlstate_of(format($q$insert into meganet.ingest_point_report
        (ingest_token_id, point_id, name, receiver, lat, lon, location_source, location_approx)
      values (%s, 'sneaky', 'sneaky', 'quansheng', -27, 153, 'browser', false)$q$,
      (select id from meganet.ingest_token where label = '_check_points laptop'))) = '23514');
end
$$;

-- ── Who can read it ──────────────────────────────────────────────────────────

do $$
declare
  v_state text;
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then return; end if;
  begin
    set local role anon;
    perform 1 from meganet.ingest_point_report limit 1;
    v_state := 'none';
  exception when others then
    v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.check_that('anon reading the reports is refused', v_state = '42501', 'got ' || v_state);
end
$$;

-- ── The readings it posts say which receiver heard them ─────────────────────

do $$
declare
  r jsonb;
begin
  r := meganet.ingest_http(jsonb_build_object(
    'source', 'serial', 'protocol', 'alert', 'path', 'serial-monitor/qs-abc123',
    'readings', jsonb_build_array(jsonb_build_object(
      'alert_id', 64377, 'reading_ts', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'value_raw', 141))));
  perform pg_temp.check_that('a reading posted with the receiver''s path is stored',
    (r ->> 'accepted')::integer = 1, r::text);
  perform pg_temp.check_that('…carrying that path, source serial and the token that posted it',
    exists (select 1 from meganet.reading rd
              join meganet.ingest_source s on s.code = rd.source
              join meganet.ingest_token t on t.id = rd.ingest_token_id
             where rd.path = 'serial-monitor/qs-abc123' and s.key = 'serial'
               and t.label = '_check_points laptop'));
end
$$;

-- ── A revoked token ──────────────────────────────────────────────────────────

do $$
begin
  update meganet.ingest_token set revoked_at = now() where label = '_check_points laptop';
  perform pg_temp.check_that('a revoked token is PT401 at once',
    pg_temp.sqlstate_of($q$select meganet.report_ingest_point('{"point_id":"qs-abc123","receiver":"quansheng"}'::jsonb)$q$) = 'PT401');
end
$$;

-- ── The verdict ─────────────────────────────────────────────────────────────

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
