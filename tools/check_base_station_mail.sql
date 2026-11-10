-- check_base_station_mail.sql — Prove 0113: the administrators are emailed
-- when a base station has not checked in for half an hour, once, and again
-- when it is back; a flapping station does not fill an inbox; one switch
-- turns it off; and nobody but an administrator touches any of it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_base_station_mail.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back — the tokens, the check-ins, the findings and
-- the stand-in for the mail sender included — so it is safe against the live
-- database, and sends nothing: account_mail_one() is replaced, inside the
-- transaction, by one that writes each message down instead. Time is moved by
-- handing the runs a `now` of their own and setting when a base station last
-- checked in, since inside one transaction the clock does not move.

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

-- The same, kept.
create or replace function pg_temp.as_role_keep(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  execute pg_catalog.format('set local role %I', p_role);
  execute p_sql into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- A base station checking in, kept: anon with its token, as PostgREST hands it over.
create or replace function pg_temp.checkin(p_token text, p_payload jsonb)
returns jsonb language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ingest-token', p_token)::text, true);
  execute 'set local role anon';
  execute pg_catalog.format('select meganet.base_station_checkin(%L::jsonb)::text', p_payload) into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.headers', '', true);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v::jsonb;
end;
$$;

-- A base station's last check-in, moved to p_at.
create or replace function pg_temp.seen(p_id bigint, p_at timestamptz)
returns void language sql as $$
  update meganet.base_station set last_seen_at = p_at, beat_at = p_at where ingest_token_id = p_id;
$$;

-- People: an editor, and two administrators — one with a second address her
-- mail goes to (0100), one who has not confirmed an address and gets none.
insert into meganet.editor_allow (entry, note) values
  ('bm-editor@example.test', 'check_base_station_mail — rolled back'),
  ('bm-admin@example.test',  'check_base_station_mail — rolled back'),
  ('bm-admin2@example.test', 'check_base_station_mail — rolled back'),
  ('bm-admin3@example.test', 'check_base_station_mail — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000b1201', 'bm-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000b1202', 'bm-admin@example.test', now()),
  ('00000000-0000-4000-8000-0000000b1203', 'bm-admin2@example.test', now()),
  ('00000000-0000-4000-8000-0000000b1204', 'bm-admin3@example.test', null)
on conflict (id) do nothing;
-- The only administrators there are, so the messages' "to" is known exactly.
update meganet.app_user set role = 'editor' where role = 'admin';
update meganet.app_user set role = 'admin'
 where id in ('00000000-0000-4000-8000-0000000b1202', '00000000-0000-4000-8000-0000000b1203', '00000000-0000-4000-8000-0000000b1204');

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',   '{"role":"anon"}'),
  ('editor', '{"role":"authenticated","email":"bm-editor@example.test","sub":"00000000-0000-4000-8000-0000000b1201"}'),
  ('admin',  '{"role":"authenticated","email":"bm-admin@example.test","sub":"00000000-0000-4000-8000-0000000b1202"}');
create or replace function pg_temp.who(p_k text) returns text language sql stable as $$ select claims from _who where k = p_k $$;

-- Two base stations.
create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated, service_role;
do $$
declare
  j jsonb;
  nm text;
begin
  -- Nothing left over from a live database decides a check.
  delete from meganet.base_station_mail;
  delete from meganet.health_finding;
  delete from meganet.health_receiver;
  delete from meganet.app_meta where key in ('base_station_mail', 'base_station_mail_after_min');
  foreach nm in array array['hut', 'hill'] loop
    j := meganet.create_ingest_token('_check bm ' || nm, null);
    insert into _ctx values ('tok_' || nm, j ->> 'token'), ('id_' || nm, j ->> 'id');
  end loop;
end
$$;
create or replace function pg_temp.ctx(p_k text) returns text language sql stable as $$ select v from _ctx where k = p_k $$;
create or replace function pg_temp.id(p_k text) returns bigint language sql stable as $$ select v::bigint from _ctx where k = p_k $$;

-- ── Shape and access ─────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('what was told is kept behind RLS, and nothing a browser holds may read or write it',
    (select relrowsecurity from pg_class where oid = 'meganet.base_station_mail'::regclass)
      and not has_table_privilege('anon', 'meganet.base_station_mail', 'select')
      and not has_table_privilege('authenticated', 'meganet.base_station_mail', 'select,insert,update,delete'));
  perform pg_temp.check_that('only the secret key may run the sender; the switch is asked for by signed-in accounts and answers administrators',
    has_function_privilege('service_role', 'meganet.send_base_station_mail(timestamptz)', 'execute')
      and not has_function_privilege('anon', 'meganet.send_base_station_mail(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.send_base_station_mail(timestamptz)', 'execute')
      and has_function_privilege('authenticated', 'meganet.admin_base_station_mail()', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_base_station_mail()', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_base_station_mail_set(boolean, integer)', 'execute'));
  perform pg_temp.check_that('an editor and a stranger are refused the switch; an administrator reads it — on, half an hour, by default',
    pg_temp.as_role('authenticated', pg_temp.who('editor'), 'select meganet.admin_base_station_mail()::text') = 'ERROR 42501'
      and pg_temp.as_role('anon', pg_temp.who('anon'), 'select meganet.admin_base_station_mail()::text') = 'ERROR 42501'
      and pg_temp.as_role('authenticated', pg_temp.who('editor'), 'select meganet.admin_base_station_mail_set(false)::text') = 'ERROR 42501'
      and (pg_temp.as_role('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail()::text')::jsonb
             @> '{"on": true, "after_min": 30, "recent": []}'::jsonb));
  perform pg_temp.check_that('…and it counts who the messages go to: administrators with a confirmed address',
    (pg_temp.as_role('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail()::text')::jsonb ->> 'people')::int = 2);
end
$$;

-- ── With no mail key, nothing is sent and nothing is remembered ──────────────

do $$
declare
  t0   timestamptz := now();
  hut  bigint := pg_temp.id('id_hut');
  r    jsonb;
begin
  perform pg_temp.checkin(pg_temp.ctx('tok_hut'), jsonb_build_object('v', 1, 'mode', 'manage', 'idle_s', 60, 'agent', jsonb_build_object('app', 'RPi ALERT', 'version', '0.23.0'),
    'beat', '{"up": 100, "rx": []}'::jsonb,
    'status', jsonb_build_object('host', jsonb_build_object('addresses', jsonb_build_array(jsonb_build_object('iface', 'wlan0', 'address', '192.168.1.55'))),
                                 'recovery', jsonb_build_object('mode', 'full', 'outages', '[]'::jsonb))));
  perform pg_temp.checkin(pg_temp.ctx('tok_hill'), '{"v": 1, "mode": "manage", "idle_s": 60, "agent": {"app": "RPi ALERT", "version": "0.22.2"}, "beat": {"rx": []}, "status": {"host": {"addresses": [{"iface": "eth0", "address": "10.0.0.7"}]}}}');
  perform pg_temp.seen(hut, t0 - interval '40 minutes');
  perform meganet.refresh_base_station_findings(t0);
  -- CI's database has no Vault: the real account_mail_one() answers false.
  if pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    r := meganet.send_base_station_mail(t0);
    perform pg_temp.check_that('with no mail key nothing is sent, and nothing is marked told — it is tried again next run',
      (r ->> 'down')::int = 0 and not exists (select 1 from meganet.base_station_mail), r::text);
  else
    perform pg_temp.check_that('with no mail key nothing is sent (skip: this database has a Vault, and a real message must not go)', true);
  end if;
end
$$;

-- From here the sender is a stand-in that writes each message down.
create temporary table _mail (n serial, sent_to text[], subject text, body text) on commit drop;
grant all on _mail to public;
grant usage on sequence _mail_n_seq to public;
create or replace function meganet.account_mail_one(p_to text[], p_subject text, p_text text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_to is null or pg_catalog.cardinality(p_to) = 0 then return false; end if;
  insert into pg_temp._mail (sent_to, subject, body) values (p_to, p_subject, p_text);
  return true;
end;
$$;

-- ── Offline, once; back, once ────────────────────────────────────────────────

do $$
declare
  t0   timestamptz := now();
  hut  bigint := pg_temp.id('id_hut');
  hill bigint := pg_temp.id('id_hill');
  r    jsonb;
  m    record;
  f    bigint;
begin
  -- A fresh start: the hut last checked in twenty minutes ago. (The hill goes
  -- on checking in all the while, until its turn below.)
  perform pg_temp.seen(hut, t0 - interval '20 minutes');
  perform meganet.refresh_base_station_findings(t0);
  r := meganet.send_base_station_mail(t0);
  perform pg_temp.check_that('twenty minutes without a check-in: a finding is open, and nobody is emailed yet',
    (r ->> 'down')::int = 0 and not exists (select 1 from _mail)
      and exists (select 1 from meganet.health_finding where ingest_token_id = hut and kind = 'base-station-quiet' and cleared_at is null), r::text);

  -- Thirty-five minutes.
  perform pg_temp.seen(hill, t0 + interval '15 minutes');
  perform meganet.refresh_base_station_findings(t0 + interval '15 minutes');
  r := meganet.send_base_station_mail(t0 + interval '15 minutes');
  select * into m from _mail order by n desc limit 1;
  perform pg_temp.check_that('thirty-five minutes: one message, to the administrators with a confirmed address',
    (r ->> 'down')::int = 1 and (select count(*) from _mail) = 1
      and (select array_agg(x order by x) from unnest(m.sent_to) x) = array['bm-admin2@example.test', 'bm-admin@example.test'], r::text || ' ' || coalesce(m.sent_to::text, ''));
  perform pg_temp.check_that('…its subject names the station; its body says when it was last heard and for how long',
    m.subject = 'Flood-Net: _check bm hut is offline'
      and m.body ~ '• _check bm hut — last heard \d\d \w{3} \d\d:\d\d \(35 min ago\)', m.subject || E'\n' || m.body);
  perform pg_temp.check_that('…that it is on Wi-Fi and what it does by itself to get back, from its last status',
    m.body ~ 'It is on Wi-Fi\. It tries to get back by itself: .* reboots itself after 45 minutes\.', m.body);
  perform pg_temp.check_that('…where to look and how to stop the messages — and no address of the station',
    m.body ~ '\?tab=basestations' and m.body ~ 'turn them off on the Base Stations tab' and m.body !~ '192\.168', m.body);

  r := meganet.send_base_station_mail(t0 + interval '20 minutes');
  perform pg_temp.seen(hill, t0 + interval '3 hours');
  perform meganet.refresh_base_station_findings(t0 + interval '3 hours');
  r := meganet.send_base_station_mail(t0 + interval '3 hours');
  perform pg_temp.check_that('told once: still offline three hours on (critical by now), and no second message',
    (select count(*) from _mail) = 1 and (r ->> 'down')::int = 0
      and (select severity from meganet.health_finding where ingest_token_id = hut and cleared_at is null) = 'critical', r::text);
  perform pg_temp.check_that('the switch shows who was told, newest first, to an administrator',
    (pg_temp.as_role('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail()::text')::jsonb -> 'recent' -> 0)
      @> jsonb_build_object('id', hut, 'label', '_check bm hut', 'up_told_at', null));

  -- It comes back eight hours after it was last heard, and says how.
  perform pg_temp.checkin(pg_temp.ctx('tok_hut'), jsonb_build_object('v', 1, 'mode', 'manage', 'idle_s', 60, 'beat', '{"up": 60, "rx": []}'::jsonb,
    'status', jsonb_build_object('host', jsonb_build_object('addresses', jsonb_build_array(jsonb_build_object('iface', 'wlan0', 'address', '192.168.1.55'))),
      'recovery', jsonb_build_object('mode', 'full', 'outages', jsonb_build_array(jsonb_build_object(
        'began', extract(epoch from t0 - interval '20 minutes') * 1000, 'ended', extract(epoch from t0 + interval '7 hours 40 minutes') * 1000,
        'kind', 'no-network', 'how', 'net-restart', 'steps', '[]'::jsonb))))));
  perform pg_temp.seen(hut, t0 + interval '7 hours 40 minutes');
  perform pg_temp.seen(hill, t0 + interval '7 hours 40 minutes');
  perform meganet.refresh_base_station_findings(t0 + interval '7 hours 41 minutes');
  r := meganet.send_base_station_mail(t0 + interval '7 hours 42 minutes');
  select * into m from _mail order by n desc limit 1;
  perform pg_temp.check_that('back: one message saying so, how long it was away, and what the station says brought it back',
    (r ->> 'back')::int = 1 and (select count(*) from _mail) = 2
      and m.subject = 'Flood-Net: _check bm hut is back'
      and m.body ~ '• _check bm hut — checking in again, after 8 h away \(last heard \d\d \w{3} \d\d:\d\d\)\. It says it got back by restarting its networking\.', r::text || E'\n' || m.body);
  r := meganet.send_base_station_mail(t0 + interval '7 hours 50 minutes');
  perform pg_temp.check_that('…once', (select count(*) from _mail) = 2 and (r ->> 'back')::int = 0
    and (select up_told_at is not null from meganet.base_station_mail where ingest_token_id = hut));

  -- ── Two at once; older software; a station with nothing to say about how ───
  delete from _mail;
  perform pg_temp.seen(hut, t0 + interval '8 hours');
  perform pg_temp.seen(hill, t0 + interval '8 hours');
  perform meganet.refresh_base_station_findings(t0 + interval '8 hours 40 minutes');
  r := meganet.send_base_station_mail(t0 + interval '8 hours 40 minutes');
  select * into m from _mail order by n desc limit 1;
  perform pg_temp.check_that('two stations away together are one message, each on its own line',
    (r ->> 'down')::int = 2 and (select count(*) from _mail) = 1 and m.subject = 'Flood-Net: 2 base stations are offline'
      and m.body ~ 'These base stations have stopped checking in:' and m.body ~ '• _check bm hut' and m.body ~ '• _check bm hill', m.subject || E'\n' || m.body);
  perform pg_temp.check_that('…a station on older software, on Ethernet, is said to be so',
    m.body ~ '• _check bm hill — [^\n]*It is on Ethernet\. Its software \(0\.22\.2\) does not try to get its link back by itself', m.body);

  -- The hill is switched off for good (its token revoked); the hut comes back
  -- with no account of how.
  update meganet.ingest_token set revoked_at = t0 + interval '9 hours' where id = hill;
  perform pg_temp.seen(hut, t0 + interval '9 hours');
  perform meganet.refresh_base_station_findings(t0 + interval '9 hours 1 minute');
  r := meganet.send_base_station_mail(t0 + interval '9 hours 2 minutes');
  select * into m from _mail order by n desc limit 1;
  perform pg_temp.check_that('a finding that cleared because the token was revoked gets no "back"; the one that is back does, with nothing made up about how',
    (r ->> 'back')::int = 1 and m.subject = 'Flood-Net: _check bm hut is back' and m.body !~ 'hill' and m.body !~ 'It says'
      and not exists (select 1 from meganet.base_station_mail where up_told_at is null), r::text || E'\n' || m.body);

  -- ── A flapping link ───────────────────────────────────────────────────────
  -- Twice told already today (above); a third, then a fourth that is held.
  delete from _mail;
  perform pg_temp.seen(hut, t0 + interval '9 hours 10 minutes');
  perform meganet.refresh_base_station_findings(t0 + interval '9 hours 45 minutes');
  r := meganet.send_base_station_mail(t0 + interval '9 hours 45 minutes');
  perform pg_temp.seen(hut, t0 + interval '9 hours 50 minutes');
  perform meganet.refresh_base_station_findings(t0 + interval '9 hours 51 minutes');
  perform meganet.send_base_station_mail(t0 + interval '9 hours 52 minutes');
  perform meganet.refresh_base_station_findings(t0 + interval '10 hours 30 minutes');
  r := meganet.send_base_station_mail(t0 + interval '10 hours 30 minutes');
  perform pg_temp.check_that('a station away for the fourth time in a day is held, not sent: three "offline" messages a day at most',
    (r ->> 'down')::int = 0 and (r ->> 'held')::int = 1
      and (select count(*) from _mail where subject ~ 'is offline') = 1
      and (select count(*) from meganet.base_station_mail where ingest_token_id = hut) = 3, r::text);
  r := meganet.send_base_station_mail(t0 + interval '34 hours');
  perform pg_temp.check_that('…and told once the day has passed, if it is still away',
    (r ->> 'down')::int = 1 and (r ->> 'held')::int = 0, r::text);

  -- ── The switch ────────────────────────────────────────────────────────────
  delete from _mail;
  delete from meganet.base_station_mail;
  r := pg_temp.as_role_keep('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail_set(false)::text')::jsonb;
  perform pg_temp.check_that('an administrator turns the messages off', (r ->> 'on')::boolean = false, r::text);
  r := meganet.send_base_station_mail(t0 + interval '35 hours');
  perform pg_temp.check_that('off: nothing is sent, and nothing remembered', (r ->> 'off')::boolean and not exists (select 1 from _mail)
    and not exists (select 1 from meganet.base_station_mail), r::text);
  r := pg_temp.as_role_keep('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail_set(true, 10)::text')::jsonb;
  perform pg_temp.check_that('…and on again, with a wait of ten minutes', (r ->> 'on')::boolean and (r ->> 'after_min')::int = 10, r::text);
  perform pg_temp.check_that('a wait under five minutes or over a day is refused',
    pg_temp.as_role('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail_set(null, 2)::text') = 'ERROR 22023'
      and pg_temp.as_role('authenticated', pg_temp.who('admin'), 'select meganet.admin_base_station_mail_set(null, 2000)::text') = 'ERROR 22023');
  perform pg_temp.seen(hut, t0 + interval '36 hours');
  perform meganet.refresh_base_station_findings(t0 + interval '36 hours 1 minute');
  perform meganet.send_base_station_mail(t0 + interval '36 hours 2 minutes');
  perform meganet.refresh_base_station_findings(t0 + interval '36 hours 12 minutes');
  r := meganet.send_base_station_mail(t0 + interval '36 hours 12 minutes');
  select * into m from _mail order by n desc limit 1;
  perform pg_temp.check_that('the wait is the one set: told at twelve minutes, and the message says ten',
    (r ->> 'down')::int = 1 and m.body ~ 'has not been heard from for 10 minutes', r::text || E'\n' || coalesce(m.body, ''));

  -- A "back" nobody was waiting for any more: cleared over a day ago.
  select finding_id into f from meganet.base_station_mail where up_told_at is null;
  update meganet.health_finding set cleared_at = last_seen where id = f;
  delete from _mail;
  r := meganet.send_base_station_mail((select cleared_at from meganet.health_finding where id = f) + interval '25 hours');
  perform pg_temp.check_that('a finding that cleared over a day ago is closed without a message',
    (r ->> 'back')::int = 0 and not exists (select 1 from _mail)
      and (select up_told_at is not null from meganet.base_station_mail where finding_id = f), r::text);

  perform pg_temp.check_that('the secret key may run the sender; a signed-in account may not',
    pg_temp.as_role('service_role', '{"role":"service_role"}', 'select meganet.send_base_station_mail()::text') !~ '^ERROR'
      and pg_temp.as_role('authenticated', pg_temp.who('admin'), 'select meganet.send_base_station_mail()::text') = 'ERROR 42501');
end
$$;

-- ── The verdict ─────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 400) end as detail
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
