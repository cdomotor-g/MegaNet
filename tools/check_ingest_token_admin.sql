-- check_ingest_token_admin.sql — Prove 0046, ingest tokens from the Admin tab.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest_token_admin.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back — the people it signs up and the tokens it mints
-- included — so it is safe against the live database. The people are made
-- through 0005's own triggers, as check_admin_dashboard.sql makes them: anon,
-- an editor, and an editor app_user calls an administrator.

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

-- One statement as another role with a request's claims: its first column as
-- text, or 'ERROR <sqlstate>'. Rolled back, so each check starts clean.
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

-- The same, kept: for the steps whose writes the next checks read.
create or replace function pg_temp.as_admin_keep(p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"tok-admin@example.test","sub":"00000000-0000-4000-8000-0000000dc502"}', true);
  execute 'set local role authenticated';
  execute p_sql into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

insert into meganet.editor_allow (entry, note) values
  ('tok-editor@example.test', 'check_ingest_token_admin — rolled back'),
  ('tok-admin@example.test',  'check_ingest_token_admin — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000dc501', 'tok-editor@example.test'),
  ('00000000-0000-4000-8000-0000000dc502', 'tok-admin@example.test')
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000dc502';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',   '{"role":"anon"}'),
  ('editor', '{"role":"authenticated","email":"tok-editor@example.test","sub":"00000000-0000-4000-8000-0000000dc501"}'),
  ('admin',  '{"role":"authenticated","email":"tok-admin@example.test","sub":"00000000-0000-4000-8000-0000000dc502"}');
grant select on _who to anon, authenticated;

-- ── Who may ──────────────────────────────────────────────────────────────────

do $$
declare
  c_anon   text := (select claims from _who where k = 'anon');
  c_editor text := (select claims from _who where k = 'editor');
begin
  perform pg_temp.check_that('anon may not list, mint or revoke',
    pg_temp.as_role('anon', c_anon, $q$select meganet.admin_ingest_tokens()::text$q$) like 'ERROR %'
      and pg_temp.as_role('anon', c_anon, $q$select meganet.admin_create_ingest_token('x')::text$q$) like 'ERROR %'
      and pg_temp.as_role('anon', c_anon, $q$select meganet.admin_revoke_ingest_token(1)::text$q$) like 'ERROR %');
  perform pg_temp.check_that('an editor who is not an administrator may not either',
    pg_temp.as_role('authenticated', c_editor, $q$select meganet.admin_ingest_tokens()::text$q$) like 'ERROR %'
      and pg_temp.as_role('authenticated', c_editor, $q$select meganet.admin_create_ingest_token('x')::text$q$) like 'ERROR %'
      and pg_temp.as_role('authenticated', c_editor, $q$select meganet.admin_revoke_ingest_token(1)::text$q$) like 'ERROR %');
  perform pg_temp.check_that('anon is not even granted them',
    not has_function_privilege('anon', 'meganet.admin_create_ingest_token(text, text)', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_ingest_tokens()', 'execute'));
end
$$;

-- ── An administrator ─────────────────────────────────────────────────────────

create temporary table _made on commit drop as
  select pg_temp.as_admin_keep($q$select meganet.admin_create_ingest_token('  _check_tok laptop  ', null)::text$q$)::jsonb as j;
grant select on _made to authenticated;

do $$
declare
  j jsonb := (select j from _made);
  c_admin text := (select claims from _who where k = 'admin');
  v_list jsonb;
begin
  perform pg_temp.check_that('an administrator mints a token and sees it once',
    j ->> 'token' like 'mgn\_%' and length(j ->> 'token') > 60 and j ->> 'label' = '_check_tok laptop', j::text);
  perform pg_temp.check_that('only its hash is kept, and the administrator is its maker',
    exists (select 1 from meganet.ingest_token t where t.id = (j ->> 'id')::bigint
              and t.token_hash = encode(sha256(convert_to(j ->> 'token', 'utf8')), 'hex')
              and t.created_by ilike '%tok-admin@example.test%'),
    (select coalesce(created_by, '<null>') from meganet.ingest_token where id = (j ->> 'id')::bigint));
  perform pg_temp.check_that('a second live token with the same label is refused (23505)',
    pg_temp.as_role('authenticated', c_admin, $q$select meganet.admin_create_ingest_token('_CHECK_TOK LAPTOP')::text$q$) = 'ERROR 23505');
  perform pg_temp.check_that('a blank label is refused (22023)',
    pg_temp.as_role('authenticated', c_admin, $q$select meganet.admin_create_ingest_token('   ')::text$q$) = 'ERROR 22023');
  perform pg_temp.check_that('a host station that does not exist is refused (22023)',
    pg_temp.as_role('authenticated', c_admin, $q$select meganet.admin_create_ingest_token('_check_tok other', '_no_such_station_')::text$q$) = 'ERROR 22023');

  v_list := pg_temp.as_role('authenticated', c_admin, $q$select meganet.admin_ingest_tokens()::text$q$)::jsonb;
  perform pg_temp.check_that('the list shows it, without its hash',
    exists (select 1 from jsonb_array_elements(v_list) e where e ->> 'label' = '_check_tok laptop' and e -> 'receivers' = '[]'::jsonb)
      and v_list::text not like '%token_hash%' and v_list::text not like '%' || (j ->> 'token') || '%');
end
$$;

-- The token works at the door, and a receiver reported behind it shows in the list.
do $$
declare
  j jsonb := (select j from _made);
begin
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', j ->> 'token'), true);
  perform meganet.report_ingest_point('{"point_id":"qs-check0046","receiver":"quansheng","name":"Check radio"}'::jsonb);
  perform set_config('request.headers', '', true);
end
$$;

do $$
declare
  j jsonb := (select j from _made);
  c_admin text := (select claims from _who where k = 'admin');
  v_list jsonb := pg_temp.as_role('authenticated', c_admin, $q$select meganet.admin_ingest_tokens()::text$q$)::jsonb;
begin
  perform pg_temp.check_that('a minted token opens the door, and its receiver shows in the list',
    exists (select 1 from jsonb_array_elements(v_list) e, jsonb_array_elements(e -> 'receivers') r
             where e ->> 'label' = '_check_tok laptop' and r ->> 'point_id' = 'qs-check0046' and (r ->> 'location_approx')::boolean));
end
$$;

-- Revoked: the door shuts at once, and the label is free again.
do $$
declare
  j jsonb := (select j from _made);
  c_admin text := (select claims from _who where k = 'admin');
  v_state text;
begin
  perform pg_temp.as_admin_keep(format('select meganet.admin_revoke_ingest_token(%s)::text', j ->> 'id'));
  perform pg_temp.check_that('revoking sets revoked_at',
    (select revoked_at is not null from meganet.ingest_token where id = (j ->> 'id')::bigint));
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', j ->> 'token'), true);
  begin
    perform meganet.report_ingest_point('{"point_id":"qs-check0046","receiver":"quansheng"}'::jsonb);
    v_state := 'none';
  exception when others then v_state := sqlstate;
  end;
  perform set_config('request.headers', '', true);
  perform pg_temp.check_that('a revoked token is refused at the door at once (PT401)', v_state = 'PT401', 'got ' || v_state);
  perform pg_temp.check_that('revoking it again changes nothing and is not an error',
    pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_revoke_ingest_token(%s)::text', j ->> 'id')) not like 'ERROR %');
  perform pg_temp.check_that('revoking a token that does not exist is 22023',
    pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_revoke_ingest_token(-1)::text') = 'ERROR 22023');
  perform pg_temp.check_that('with that one revoked, its label may be used again',
    pg_temp.as_role('authenticated', c_admin, $q$select meganet.admin_create_ingest_token('_check_tok laptop')::text$q$) not like 'ERROR %');
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
