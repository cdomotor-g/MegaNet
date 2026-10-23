-- check_base_station_links.sql — Prove 0080: a base station's check-ins leave
-- a record of its connection — a gap since the last check-in as a dropout, a
-- restart or an agent restart by its heartbeat's uptime; a change of public
-- address block, of address within a block, or of route — the full address
-- never kept, a check-in never failed by it, and administrators the only
-- readers.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_base_station_links.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database. The
-- base station is anon holding a token in X-Ingest-Token, with the address
-- headers PostgREST hands over (X-Forwarded-For, CF-Connecting-IP, CF-Worker).
-- One transaction is one now(), so a gap is made by moving last_seen_at back
-- before the check-in that ends it.

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

-- A check-in from an address, kept: anon, the token and p_headers as
-- PostgREST hands them over → the answer, or 'ERROR <sqlstate>'.
create or replace function pg_temp.checkin(p_token text, p_headers jsonb, p_payload jsonb)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_catalog.set_config('request.headers',
    (coalesce(p_headers, '{}'::jsonb) || pg_catalog.jsonb_build_object('x-ingest-token', p_token))::text, true);
  execute 'set local role anon';
  begin
    execute pg_catalog.format('select meganet.base_station_checkin(%L::jsonb)::text', p_payload) into v;
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  execute 'reset role';
  perform pg_catalog.set_config('request.headers', '', true);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- One statement as another role with a request's claims: its first column as
-- text, or 'ERROR <sqlstate>'. Rolled back.
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

insert into meganet.editor_allow (entry, note) values
  ('bl-editor@example.test', 'check_base_station_links — rolled back'),
  ('bl-admin@example.test',  'check_base_station_links — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000b1801', 'bl-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000b1802', 'bl-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000b1802';

create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated;
create or replace function pg_temp.ctx(p_k text) returns text language sql as $$ select v from _ctx where k = p_k $$;

do $$
declare
  j jsonb;
begin
  j := meganet.create_ingest_token('_check bl one', null);
  insert into _ctx values ('tok', j ->> 'token'), ('id', j ->> 'id');
end
$$;

-- The gap: the last check-in — and the heartbeat it carried — moved back p_s
-- seconds, as owner. Its own update carries no request, so it is no check-in
-- to the trigger.
create or replace function pg_temp.back(p_s integer) returns void language sql as $$
  update meganet.base_station set last_seen_at = now() - p_s * interval '1 second',
                                  beat_at = beat_at - p_s * interval '1 second'
   where ingest_token_id = pg_temp.ctx('id')::bigint;
$$;

create or replace function pg_temp.events() returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'seconds', seconds, 'from', addr_from, 'to', addr_to, 'detail', detail) order by id), '[]'::jsonb)
    from meganet.base_station_link where ingest_token_id = pg_temp.ctx('id')::bigint;
$$;
create or replace function pg_temp.n() returns integer language sql as $$
  select count(*)::integer from meganet.base_station_link where ingest_token_id = pg_temp.ctx('id')::bigint;
$$;
create or replace function pg_temp.last_event() returns jsonb language sql as $$
  select pg_temp.events() -> -1;
$$;

-- ── A first check-in ────────────────────────────────────────────────────────

do $$
declare
  a text;
  net jsonb;
begin
  a := pg_temp.checkin(pg_temp.ctx('tok'), '{"x-forwarded-for":"203.0.113.7","cf-connecting-ip":"203.0.113.7"}',
                       '{"v":1,"mode":"manage","idle_s":60,"beat":{"up":500000,"agent_up":400000}}');
  select b.net into net from meganet.base_station b where b.ingest_token_id = pg_temp.ctx('id')::bigint;
  perform pg_temp.check_that('a first check-in is answered as before',
    a not like 'ERROR%' and (a::jsonb ->> 'next_s')::integer = 60, a);
  perform pg_temp.check_that('…and keeps where it called from: its block only, the route, the family',
    net -> 'v4' ->> 'addr' = '203.0.x.x' and net ->> 'route' = 'direct' and net ->> 'family' = 'v4', coalesce(net::text, 'null'));
  perform pg_temp.check_that('…never the address itself, anywhere on the row or the record',
    position('203.0.113.7' in coalesce(net::text, '')) = 0
      and not exists (select 1 from meganet.base_station_link l where position('203.0.113.7' in l::text) > 0), net::text);
  perform pg_temp.check_that('…and it is no event: nothing came before it', pg_temp.n() = 0, pg_temp.events()::text);
end
$$;

-- ── Gaps ────────────────────────────────────────────────────────────────────

do $$
declare
  h jsonb := '{"x-forwarded-for":"203.0.113.7"}';
  e jsonb;
begin
  perform pg_temp.back(120);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":60,"beat":{"up":500120,"agent_up":400120}}');
  perform pg_temp.check_that('two minutes since the last check-in is no gap (the line is three idle periods, three minutes at least)',
    pg_temp.n() = 0, pg_temp.events()::text);

  perform pg_temp.back(600);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":60,"beat":{"up":500720,"agent_up":400720}}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('ten minutes with the computer up all along is a dropout, from the last check-in to this one',
    pg_temp.n() = 1 and e ->> 'kind' = 'dropout' and (e ->> 'seconds')::integer = 600
      and e -> 'detail' ->> 'source' = 'checkins' and (e -> 'detail' ->> 'up_s')::integer = 500720, e::text);

  perform pg_temp.back(600);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":60,"beat":{"up":95,"agent_up":80}}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('…the computer up for less than the gap is a restart',
    pg_temp.n() = 2 and e ->> 'kind' = 'restart', e::text);

  perform pg_temp.back(600);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":60,"beat":{"up":9000,"agent_up":40}}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('…only the software up for less than the gap is an agent restart',
    pg_temp.n() = 3 and e ->> 'kind' = 'agent', e::text);

  perform pg_temp.back(600);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":60}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('…and with no heartbeat on the check-in that ends it, a dropout: nothing says otherwise',
    pg_temp.n() = 4 and e ->> 'kind' = 'dropout' and not (e -> 'detail' ? 'up_s'), e::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":600}');
  perform pg_temp.back(1500);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"idle_s":600}');
  perform pg_temp.check_that('a station that checks in every ten minutes is gapped at thirty, not three',
    pg_temp.n() = 4, pg_temp.events()::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"mode":"off","idle_s":60}');
  perform pg_temp.back(3600);
  perform pg_temp.checkin(pg_temp.ctx('tok'), h, '{"v":1,"mode":"manage","idle_s":60}');
  perform pg_temp.check_that('a station that said off is not gapped: it said it would stop',
    pg_temp.n() = 4, pg_temp.events()::text);
end
$$;

-- ── Address and route ───────────────────────────────────────────────────────

do $$
declare
  e jsonb;
  net jsonb;
  a text;
begin
  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"x-forwarded-for":"198.51.100.9"}', '{"v":1}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('a new IPv4 block is an address event, block to block',
    pg_temp.n() = 5 and e ->> 'kind' = 'address' and e ->> 'from' = '203.0.x.x' and e ->> 'to' = '198.51.x.x'
      and e -> 'detail' ->> 'family' = 'v4' and e -> 'detail' ->> 'route' = 'direct', e::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"x-forwarded-for":"198.51.100.10, 10.0.0.1"}', '{"v":1}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('…a new address in the same block too, by its fingerprint; the first X-Forwarded-For is the station',
    pg_temp.n() = 6 and e ->> 'kind' = 'address' and e ->> 'from' = '198.51.x.x' and e ->> 'to' = '198.51.x.x', e::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"x-forwarded-for":"198.51.100.10"}', '{"v":1}');
  perform pg_temp.check_that('…and the same address again is nothing', pg_temp.n() = 6, pg_temp.events()::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"cf-connecting-ip":"2001:db8:1:2::5"}', '{"v":1}');
  select b.net into net from meganet.base_station b where b.ingest_token_id = pg_temp.ctx('id')::bigint;
  perform pg_temp.check_that('IPv6 is followed apart from IPv4: its first appearance is no event, and IPv4 is still known',
    pg_temp.n() = 6 and net -> 'v6' ->> 'addr' = '2001:db8::/32' and net ->> 'family' = 'v6'
      and net -> 'v4' ->> 'addr' = '198.51.x.x', net::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"cf-connecting-ip":"2001:db8:1:2:abcd::99"}', '{"v":1}');
  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"x-forwarded-for":"198.51.100.10"}', '{"v":1}');
  perform pg_temp.check_that('…a new host in the same /64 is not a new connection, and going back to IPv4 is not a change',
    pg_temp.n() = 6, pg_temp.events()::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'), '{"cf-connecting-ip":"2001:db8:1:3::5"}', '{"v":1}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('…a new /64 is',
    pg_temp.n() = 7 and e ->> 'kind' = 'address' and e -> 'detail' ->> 'family' = 'v6', e::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'),
    '{"x-forwarded-for":"2001:db8:1:3::5, 2a06:98c0:3600::103","cf-connecting-ip":"2a06:98c0:3600::103","cf-worker":"floodwarning.net"}', '{"v":1}');
  e := pg_temp.last_event();
  perform pg_temp.check_that('through floodwarning.net''s Worker is a route event, and the station''s address is still the one it forwarded',
    pg_temp.n() = 8 and e ->> 'kind' = 'route' and e ->> 'from' = 'direct' and e ->> 'to' = 'floodwarning.net', pg_temp.events()::text);

  perform pg_temp.checkin(pg_temp.ctx('tok'),
    '{"x-forwarded-for":"2001:db8:1:3::5","cf-connecting-ip":"2a06:98c0:3600::103"}', '{"v":1}');
  perform pg_temp.check_that('…the Workers range alone says so too',
    pg_temp.n() = 8, pg_temp.events()::text);

  a := pg_temp.checkin(pg_temp.ctx('tok'), '{"x-forwarded-for":"not an address","cf-connecting-ip":"nor this"}', '{"v":1}');
  perform pg_temp.check_that('headers that are not addresses never fail a check-in',
    a not like 'ERROR%' and pg_temp.n() = 8, a);
  a := pg_temp.checkin(pg_temp.ctx('tok'), '{}', '{"v":1,"beat":{"up":"soon"}}');
  perform pg_temp.check_that('…and neither does a heartbeat whose uptime is not a number', a not like 'ERROR%', a);
end
$$;

-- ── Who may read it ─────────────────────────────────────────────────────────

do $$
declare
  admin  text := '{"role":"authenticated","email":"bl-admin@example.test","sub":"00000000-0000-4000-8000-0000000b1802"}';
  editor text := '{"role":"authenticated","email":"bl-editor@example.test","sub":"00000000-0000-4000-8000-0000000b1801"}';
  r jsonb;
  s jsonb;
begin
  r := pg_temp.as_role('authenticated', admin, 'select meganet.admin_base_station_links(30)::text')::jsonb;
  select x into s from jsonb_array_elements(r -> 'stations') x where (x ->> 'id')::bigint = pg_temp.ctx('id')::bigint;
  perform pg_temp.check_that('an administrator reads the station: its state, where it calls from and its events, newest first',
    s ->> 'state' = 'online' and s -> 'net' ->> 'route' = 'floodwarning.net' and s -> 'net' -> 'v4' ->> 'addr' = '198.51.x.x'
      and jsonb_array_length(s -> 'events') = 8 and s -> 'events' -> 0 ->> 'kind' = 'route', coalesce(s::text, r::text));
  perform pg_temp.check_that('…never a fingerprint', position('"key"' in s::text) = 0, s -> 'net' ->> 'v4');
  perform pg_temp.check_that('…and the window is clamped to a year',
    (pg_temp.as_role('authenticated', admin, 'select meganet.admin_base_station_links(100000)::text')::jsonb ->> 'days')::integer = 365);
  perform pg_temp.check_that('an editor is refused',
    pg_temp.as_role('authenticated', editor, 'select meganet.admin_base_station_links(30)::text') = 'ERROR 42501');
  perform pg_temp.check_that('anon is refused',
    pg_temp.as_role('anon', '{"role":"anon"}', 'select meganet.admin_base_station_links(30)::text') like 'ERROR 42%');
  perform pg_temp.check_that('…and nobody reads the table itself',
    pg_temp.as_role('authenticated', admin, 'select count(*)::text from meganet.base_station_link') like 'ERROR 42%');
end
$$;

-- ── The verdict ─────────────────────────────────────────────────────────────

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
