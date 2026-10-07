-- check_admin_dashboard.sql — Prove the Admin tab's dashboard and visit log
-- (0043) against a real database: who may read it, what a visit records, and
-- the bounds on an anonymous write.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_admin_dashboard.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database: nothing it writes survives. It prints a row per
-- check and exits non-zero if any failed. CI runs it in the db-checks job
-- (.github/workflows/web-smoke.yml).

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

-- Run one statement as another role with a request's claims and answer with its
-- first column as text, or 'ERROR <sqlstate>' — then roll it back, so every
-- check starts from the same people (check_photo_review.sql's helper).
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
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

-- ── The people ───────────────────────────────────────────────────────────────

insert into meganet.editor_allow (entry, note) values
  ('dash-editor@example.test', 'check_admin_dashboard — rolled back'),
  ('dash-admin@example.test',  'check_admin_dashboard — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000da501', 'dash-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000da502', 'dash-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000da502';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',    '{"role":"anon"}'),
  ('editor',  '{"role":"authenticated","email":"dash-editor@example.test","sub":"00000000-0000-4000-8000-0000000da501"}'),
  ('admin',   '{"role":"authenticated","email":"dash-admin@example.test","sub":"00000000-0000-4000-8000-0000000da502"}');

-- Visits written here stay for the checks below: as_role rolls its own
-- statement back, so these are made as the script's connection with the
-- claims set, the way PostgREST sets them.
create or replace function pg_temp.visit(p_claims text, p_visitor uuid, p_tab text, p_device text default null)
returns void language plpgsql as $$
begin
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  perform meganet.log_visit(p_visitor, p_tab, p_device);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 1. Who may read it ───────────────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.admin_dashboard()::text');
  perform pg_temp.check_that('anonymous cannot read the dashboard', v like 'ERROR%', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), 'select meganet.admin_dashboard()::text');
  perform pg_temp.check_that('an editor cannot read the dashboard', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (meganet.admin_dashboard() -> 'db' ->> 'size_bytes')$q$);
  perform pg_temp.check_that('an administrator reads the database size', v ~ '^[0-9]+$', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (select count(*) from jsonb_array_elements(meganet.admin_dashboard() -> 'tables') t
                     where t ->> 'schema' = 'meganet' and t ->> 'name' = 'station')::text$q$);
  perform pg_temp.check_that('the table list includes meganet.station', v = '1', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select count(*)::text from meganet.app_visit');
  perform pg_temp.check_that('anonymous cannot select the visit log', v like 'ERROR%', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), 'select count(*)::text from meganet.app_visit');
  perform pg_temp.check_that('an editor cannot select the visit log', v like 'ERROR%', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'),
         $q$select 'ok' from (select meganet.log_visit('00000000-0000-4000-8000-0000000da5ff', 'stations', 'phone')) x$q$);
  perform pg_temp.check_that('anonymous may log a visit', v = 'ok', v);
end
$$;

-- ── 2. What a visit records ──────────────────────────────────────────────────

select pg_temp.visit((select claims from _who where k = 'anon'), '00000000-0000-4000-8000-0000000da5a1', 'stations', 'phone');
select pg_temp.visit((select claims from _who where k = 'anon'), '00000000-0000-4000-8000-0000000da5a1', 'stations');
select pg_temp.visit((select claims from _who where k = 'anon'), '00000000-0000-4000-8000-0000000da5a1', 'Bad Tab; drop');
select pg_temp.visit((select claims from _who where k = 'anon'), '00000000-0000-4000-8000-0000000da5a1', 'admin', 'toaster');
select pg_temp.visit((select claims from _who where k = 'editor'), '00000000-0000-4000-8000-0000000da5a2', 'photos', 'desktop');

do $$
declare r meganet.app_visit;
begin
  select * into r from meganet.app_visit where day = current_date and visitor = '00000000-0000-4000-8000-0000000da5a1';
  perform pg_temp.check_that('a visitor is one row a day, however many hits', r.hits = 4, r.hits::text);
  perform pg_temp.check_that('tabs are kept once each, and a non-slug tab is dropped',
    r.tabs = array['stations', 'admin'], r.tabs::text);
  perform pg_temp.check_that('an unknown device does not overwrite a known one', r.device = 'phone', r.device);
  perform pg_temp.check_that('an anonymous visit names nobody', not r.signed_in and r.user_id is null);

  select * into r from meganet.app_visit where day = current_date and visitor = '00000000-0000-4000-8000-0000000da5a2';
  perform pg_temp.check_that('a signed-in visit records who',
    r.signed_in and r.user_id = '00000000-0000-4000-8000-0000000da501'::uuid, coalesce(r.user_id::text, 'null'));
end
$$;

do $$
declare v text;
begin
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (select e ->> 'visits_30d' from jsonb_array_elements(meganet.admin_users()) e
                     where e ->> 'email' = 'dash-editor@example.test')$q$);
  perform pg_temp.check_that('admin_users counts a person''s visits', v = '1', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (select e ->> 'last_seen_at' from jsonb_array_elements(meganet.admin_users()) e
                     where e ->> 'email' = 'dash-editor@example.test')$q$);
  perform pg_temp.check_that('…and says when they were last seen', v is not null and v <> '<null>', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (meganet.admin_dashboard() -> 'visits' -> 'days' -> -1 ->> 'anonymous')$q$);
  perform pg_temp.check_that('today''s anonymous visitors are counted', v ~ '^[0-9]+$' and v::int >= 1, v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select jsonb_array_length(meganet.admin_dashboard() -> 'visits' -> 'days')::text$q$);
  perform pg_temp.check_that('the visit chart is thirty days, gaps included', v = '30', v);
end
$$;

-- ── 3. The bounds ────────────────────────────────────────────────────────────

insert into meganet.app_visit (day, visitor) values (current_date - 401, '00000000-0000-4000-8000-0000000da5b0');
insert into meganet.app_visit (day, visitor)
select current_date, gen_random_uuid() from generate_series(1, 5000);
select pg_temp.visit((select claims from _who where k = 'anon'), '00000000-0000-4000-8000-0000000da5b1', 'stations');
select pg_temp.visit((select claims from _who where k = 'anon'), '00000000-0000-4000-8000-0000000da5a1', 'stations');

do $$
begin
  perform pg_temp.check_that('a full day takes no new visitor',
    not exists (select 1 from meganet.app_visit where visitor = '00000000-0000-4000-8000-0000000da5b1'));
  perform pg_temp.check_that('…but still counts one it already has',
    (select hits from meganet.app_visit where day = current_date and visitor = '00000000-0000-4000-8000-0000000da5a1') = 5);
  perform pg_temp.check_that('visits older than 400 days are deleted on the way past',
    not exists (select 1 from meganet.app_visit where visitor = '00000000-0000-4000-8000-0000000da5b0'));
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
