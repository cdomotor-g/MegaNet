-- check_receptions.sql — Prove 0047, receptions kept, against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_receptions.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the token, the people and the receptions included — so it is
-- safe against the live database.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.sqlstate_of(p_sql text)
returns text language plpgsql as $$ begin execute p_sql; return 'none'; exception when others then return sqlstate; end; $$;
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

insert into meganet.editor_allow (entry, note) values ('rx-editor@example.test', 'check_receptions — rolled back') on conflict (entry) do nothing;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000ee501', 'rx-editor@example.test') on conflict (id) do nothing;

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_rx van') ->> 'token') as token;

do $$
declare
  v_tok text := (select token from _tok);
  r jsonb;
  b jsonb;
begin
  perform pg_temp.check_that('anon may post receptions (the token authorises) but not read them',
    has_function_privilege('anon', 'meganet.report_receptions(jsonb)', 'execute')
      and not has_table_privilege('anon', 'meganet.reception', 'select')
      and not has_function_privilege('anon', 'meganet.reception_window(timestamptz, timestamptz, integer)', 'execute'));

  perform set_config('request.headers', '', true);
  perform pg_temp.check_that('no token is PT401',
    pg_temp.sqlstate_of($q$select meganet.report_receptions('{"point_id":"sdr-van01","receiver":"rtl-sdr","receptions":[]}'::jsonb)$q$) = 'PT401');
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', v_tok), true);

  b := jsonb_build_object('point_id', 'sdr-van01', 'receiver', 'rtl-sdr', 'receptions', jsonb_build_array(
    jsonb_build_object('heard_at', to_char(now() - interval '5 min', 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'protocol', 'alert', 'alert_id', 64301, 'value_raw', 141,
      'ok', true, 'rssi_dbm', -95, 'lat', -27.5, 'lon', 152.0, 'accuracy_m', 5, 'location_source', 'gps', 'votes', 9),
    jsonb_build_object('heard_at', to_char(now() - interval '5 min' + interval '900 ms', 'YYYY-MM-DD"T"HH24:MI:SS.MSOF'), 'protocol', 'alert', 'alert_id', 64301, 'value_raw', 173,
      'ok', true, 'rssi_dbm', -88, 'lat', -27.5, 'lon', 152.0, 'location_source', 'browser'),
    jsonb_build_object('heard_at', to_char(now() - interval '4 min', 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'protocol', 'alert', 'ok', false, 'fault', 'undecoded', 'level_dbfs', -31.5),
    jsonb_build_object('heard_at', '1970-01-01T00:00:00Z', 'alert_id', 64302, 'value_raw', 1, 'ok', true),
    jsonb_build_object('heard_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'alert_id', 64303, 'value_raw', 1, 'ok', true, 'fault', 'shadow')));
  r := meganet.report_receptions(b);
  perform pg_temp.check_that('a batch stores its good rows and refuses its bad ones by index',
    (r ->> 'accepted')::int = 3 and jsonb_array_length(r -> 'rejected') = 2
      and (r -> 'rejected' -> 0 ->> 'i')::int = 3 and (r -> 'rejected' -> 1 ->> 'i')::int = 4, r::text);
  perform pg_temp.check_that('a GPS position is stored exact, a browser one approximate',
    (select bool_and(case location_source when 'gps' then not location_approx when 'browser' then location_approx else true end)
       from meganet.reception where point_id = 'sdr-van01'));
  perform pg_temp.check_that('a reception with no position stores none',
    exists (select 1 from meganet.reception where point_id = 'sdr-van01' and fault = 'undecoded' and lat is null and location_source = 'none'));
  r := meganet.report_receptions(b);
  perform pg_temp.check_that('the same batch again stores nothing twice', (r ->> 'accepted')::int = 0 and (r ->> 'duplicates')::int = 3, r::text);
  perform pg_temp.check_that('an unknown receiver is 22023',
    pg_temp.sqlstate_of($q$select meganet.report_receptions('{"point_id":"abc","receiver":"walkie","receptions":[]}'::jsonb)$q$) = '22023');
  perform pg_temp.check_that('the table itself refuses an approximate position stored as exact',
    pg_temp.sqlstate_of(format($q$insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, ok, lat, lon, location_source, location_approx)
      values (%s, 'sneaky', 'rtl-sdr', now(), true, -27, 153, 'browser', false)$q$,
      (select id from meganet.ingest_token where label = '_check_rx van'))) = '23514');
  perform set_config('request.headers', '', true);
end
$$;

do $$
declare
  c_editor text := '{"role":"authenticated","email":"rx-editor@example.test","sub":"00000000-0000-4000-8000-0000000ee501"}';
  v text;
begin
  v := pg_temp.as_role('authenticated', c_editor, $q$select meganet.reception_window(now() - interval '1 hour')::text$q$);
  perform pg_temp.check_that('an editor reads a window, oldest first, with the token''s label',
    v not like 'ERROR %' and (v::jsonb -> 0 ->> 'value_raw')::int = 141 and v::jsonb -> 0 ->> 'token_label' = '_check_rx van'
      and jsonb_array_length(v::jsonb) >= 3, left(v, 200));
  perform pg_temp.check_that('anon reading a window is refused',
    pg_temp.as_role('anon', '{"role":"anon"}', $q$select meganet.reception_window(now() - interval '1 hour')::text$q$) like 'ERROR %');
end
$$;

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then raise exception '% of % checks failed', n, (select count(*) from _check); end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
