-- check_push.sql — Prove 0066 against a real database: only an administrator
-- turns notifications on for a device, and only at a push service Flood-Net
-- sends to, with the server's own key; the sender — and nobody in a browser —
-- hears which devices have something new, once per arrival, with the count for
-- the badge; a device that stops being an administrator's, or was made with
-- another key, hears nothing; and what a push service says comes back to the
-- panel, a subscription it calls gone going with it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_push.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database: nothing it writes survives. It prints a row per
-- check and exits non-zero if any failed. CI runs it in the db-checks job
-- (.github/workflows/web-smoke.yml).
--
-- One transaction has one now(), so "arrived since the device was last told"
-- is set up by moving the device's mark back an hour and dating each arrival
-- inside that hour, rather than by waiting.

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

-- check_accounts.sql's two helpers: one statement as another role with a
-- request's claims, rolled back (as_role) or kept (as_role_keep).
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

create or replace function pg_temp.as_role_keep(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  execute pg_catalog.format('set local role %I', p_role);
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  begin
    execute p_sql into v;
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return coalesce(v, '<null>');
end;
$$;

-- What push_due() answers for this script's devices only: a live database may
-- hold others.
create or replace function pg_temp.due(p_key text)
returns jsonb language sql as $$
  select coalesce(pg_catalog.jsonb_agg(x order by (x ->> 'id')::bigint), '[]'::jsonb)
    from pg_catalog.jsonb_array_elements(meganet.push_due(p_key)) x
   where (x ->> 'id')::bigint in (select s.id from meganet.push_subscription s
                                   where s.endpoint like '%check-push-%');
$$;

-- …and the sender's report, every device answered with one status.
create or replace function pg_temp.done(p_due jsonb, p_status integer)
returns jsonb language sql as $$
  select meganet.push_done(coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', x -> 'id', 'status', p_status, 'through', x -> 'through', 'asked', x -> 'asked',
           'error', case when p_status >= 300 then 'HTTP ' || p_status end)), '[]'::jsonb))
    from pg_catalog.jsonb_array_elements(p_due) x;
$$;

-- ── The people, the keys, the devices ────────────────────────────────────────

update meganet.app_meta set value = 'open' where key = 'signup';
insert into meganet.editor_allow (entry, note) values
  ('@push-bureau.test', 'check_push — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-00000000b001', 'admin@push-bureau.test',  now()),
  ('00000000-0000-4000-8000-00000000b002', 'second@push-bureau.test', now()),
  ('00000000-0000-4000-8000-00000000b003', 'editor@push-bureau.test', now()),
  ('00000000-0000-4000-8000-00000000b004', 'member@push-council.test', now())
on conflict (id) do nothing;

-- Only this script's administrators, whatever the database already holds.
update meganet.app_user set role = 'editor' where role = 'admin'
   and id not in ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000b002');
update meganet.app_user set role = 'admin'
 where id in ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000b002');
update meganet.app_user set status = 'approved', decided_at = now(), decided_by = 'check_push'
 where id = '00000000-0000-4000-8000-00000000b004';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',    '{"role":"anon"}'),
  ('admin',   '{"role":"authenticated","email":"admin@push-bureau.test","sub":"00000000-0000-4000-8000-00000000b001"}'),
  ('second',  '{"role":"authenticated","email":"second@push-bureau.test","sub":"00000000-0000-4000-8000-00000000b002"}'),
  ('editor',  '{"role":"authenticated","email":"editor@push-bureau.test","sub":"00000000-0000-4000-8000-00000000b003"}'),
  ('member',  '{"role":"authenticated","email":"member@push-council.test","sub":"00000000-0000-4000-8000-00000000b004"}'),
  ('service', '{"role":"service_role"}');

-- Two VAPID public keys (any 65-byte point's shape will do here: the database
-- holds keys, it does not do the cryptography), a device's keys, and the
-- endpoints, all marked so a live database's own devices are left out.
create temporary table _k (k text primary key, val text) on commit drop;
insert into _k values
  ('vapid',  'B' || repeat('A', 86)),
  ('vapid2', 'B' || repeat('C', 86)),
  ('p256dh', 'B' || repeat('D', 86)),
  ('auth',   repeat('E', 22)),
  ('apple',  'https://web.push.apple.com/check-push-apple'),
  ('fcm',    'https://fcm.googleapis.com/fcm/send/check-push-fcm'),
  ('moz',    'https://updates.push.services.mozilla.com/wpush/v2/check-push-moz'),
  ('wns',    'https://wns2-sy3p.notify.windows.com/w/?token=check-push-wns');

-- A subscribe call as somebody, with this script's keys.
create or replace function pg_temp.sub_sql(p_endpoint text, p_key text, p_label text default 'iPhone · Safari')
returns text language sql as $$
  select pg_catalog.format('select meganet.push_subscribe(%L, %L, %L, %L, %L)::text',
           p_endpoint, (select val from _k where k = 'p256dh'), (select val from _k where k = 'auth'), p_key, p_label);
$$;

-- ── 1. Who may reach what ────────────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.push_mine()::text');
  perform pg_temp.check_that('anonymous cannot read the panel''s state', v = 'ERROR 42501', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'),
         pg_temp.sub_sql((select val from _k where k = 'apple'), (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('…nor turn a device on', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.push_due('B$q$ || repeat('A', 86) || $q$')::text$q$);
  perform pg_temp.check_that('no browser role asks what is due — not even an administrator', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), $q$select meganet.push_done('[]')::text$q$);
  perform pg_temp.check_that('…nor reports what was sent', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), 'select meganet.push_waiting()::text');
  perform pg_temp.check_that('…nor reads the queues through the sender''s helper', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.push_trim('00000000-0000-4000-8000-00000000b002')::text$q$);
  perform pg_temp.check_that('…nor trims somebody else''s devices through the subscribe helper', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), 'select count(*)::text from meganet.push_subscription');
  perform pg_temp.check_that('the table is nobody''s to read directly', v = 'ERROR 42501', v);
  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'), $q$select meganet.push_done('[]')::text$q$);
  perform pg_temp.check_that('the service key reports', v::jsonb = '{"sent":0,"gone":0,"failed":0}', v);
end
$$;

-- ── 2. Turning a device on ───────────────────────────────────────────────────

do $$
declare v text;
begin
  delete from meganet.app_meta where key in ('push_public_key', 'push_last_run');

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), 'select meganet.push_mine()::text');
  perform pg_temp.check_that('before the sender has run: no key, no run, and the administrator''s queues counted',
    (v::jsonb -> 'key') = 'null' and (v::jsonb -> 'last_run') = 'null' and (v::jsonb ->> 'is_admin')::boolean
      and (v::jsonb #>> '{waiting,total}')::int = (meganet.push_waiting() ->> 'total')::int
      and not (v::jsonb -> 'waiting') ? 'one_token', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql((select val from _k where k = 'apple'), (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('…and no device can be turned on: the server is not set up', v = 'ERROR 55000', v);

  v := (meganet.push_due((select val from _k where k = 'vapid')))::text;
  perform pg_temp.check_that('the sender''s first run records its key and that it ran',
    (select value from meganet.app_meta where key = 'push_public_key') = (select val from _k where k = 'vapid')
      and (select value from meganet.app_meta where key = 'push_last_run') is not null, v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), $q$select meganet.push_mine() ->> 'last_run'$q$);
  perform pg_temp.check_that('…which the panel reads as ISO 8601, a date Safari can parse',
    v ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d', v);
  begin
    perform meganet.push_due('not a key');
    v := 'answered';
  exception when others then v := 'ERROR ' || sqlstate;
  end;
  perform pg_temp.check_that('…and refuses a key that is not a P-256 point', v = 'ERROR 22023', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
         pg_temp.sub_sql((select val from _k where k = 'apple'), (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('an editor who is not an administrator cannot turn a device on', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'member'),
         pg_temp.sub_sql((select val from _k where k = 'apple'), (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('…nor a member', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql((select val from _k where k = 'apple'), (select val from _k where k = 'vapid2')));
  perform pg_temp.check_that('an administrator''s page with another key is told to reload', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql('https://push.example.test/check-push-elsewhere', (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('an endpoint that is not one of the four push services is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql('http://web.push.apple.com/check-push-plain', (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('…and so is plain http to one that is', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         pg_catalog.format('select meganet.push_subscribe(%L, %L, %L, %L)::text', (select val from _k where k = 'apple'),
                           'short', (select val from _k where k = 'auth'), (select val from _k where k = 'vapid')));
  perform pg_temp.check_that('…and a device key that is not a P-256 point', v = 'ERROR 22023', v);

  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql((select val from _k where k = 'apple'), (select val from _k where k = 'vapid'), E'  iPhone\u0007 · Safari  '));
  perform pg_temp.check_that('an administrator turns their iPhone on', v::jsonb ? 'id', v);
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql((select val from _k where k = 'fcm'), (select val from _k where k = 'vapid'), 'Android · Chrome'));
  perform pg_temp.check_that('…and an Android phone (Google''s push service)', v::jsonb ? 'id', v);
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'second'),
         pg_temp.sub_sql((select val from _k where k = 'moz'), (select val from _k where k = 'vapid'), 'Mac · Firefox'));
  perform pg_temp.check_that('a second administrator turns on Firefox (Mozilla''s)', v::jsonb ? 'id', v);
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'second'),
         pg_temp.sub_sql((select val from _k where k = 'wns'), (select val from _k where k = 'vapid'), 'Windows · Edge'));
  perform pg_temp.check_that('…and Edge on Windows (Microsoft''s)', v::jsonb ? 'id', v);

  select label into v from meganet.push_subscription where endpoint = (select val from _k where k = 'apple');
  perform pg_temp.check_that('a device''s name is kept trimmed, its control characters gone', v = 'iPhone · Safari', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), 'select meganet.push_mine()::text');
  perform pg_temp.check_that('the panel lists the administrator''s own two devices and nobody else''s, with the key',
    pg_catalog.jsonb_array_length(v::jsonb -> 'devices') = 2
      and (v::jsonb ->> 'key') = (select val from _k where k = 'vapid')
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v::jsonb -> 'devices') d
                       where d ->> 'endpoint' in ((select val from _k where k = 'moz'), (select val from _k where k = 'wns'))
                          or not (d ->> 'current_key')::boolean or not (d ->> 'test_waiting')::boolean), v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'member'), 'select meganet.push_mine()::text');
  perform pg_temp.check_that('a member''s panel: no devices, not an administrator, nothing waiting for them',
    v::jsonb @> '{"devices":[],"is_admin":false}' and (v::jsonb -> 'waiting') = 'null', v);
end
$$;

-- ── 3. The first run: a test for each new device ─────────────────────────────

do $$
declare v jsonb; t text;
begin
  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('the next run has a message for each of the four new devices', pg_catalog.jsonb_array_length(v) = 4, v::text);
  perform pg_temp.check_that('…saying notifications are on, with what is waiting as its body and badge',
    not exists (select 1 from pg_catalog.jsonb_array_elements(v) x
                 where x #>> '{payload,title}' <> 'Flood-Net notifications are on'
                    or (x #>> '{payload,count}')::int <> (meganet.push_waiting() ->> 'total')::int
                    or x #>> '{payload,tag}' <> 'floodnet-admin'
                    or x #>> '{payload,url}' <> './?tab=admin'
                    or x ->> 'urgency' <> 'normal'
                    or x ->> 'asked' is null), v::text);
  perform pg_temp.check_that('…each with the endpoint and keys to send it with',
    not exists (select 1 from pg_catalog.jsonb_array_elements(v) x
                 where x ->> 'p256dh' <> (select val from _k where k = 'p256dh') or x ->> 'auth' <> (select val from _k where k = 'auth')
                    or x ->> 'endpoint' not like 'https://%'), v::text);

  t := (pg_temp.done(v, 201))::text;
  perform pg_temp.check_that('the sender reports all four delivered', t::jsonb = '{"sent":4,"gone":0,"failed":0}', t);
  perform pg_temp.check_that('…which the devices keep: sent, no error, no test waiting',
    not exists (select 1 from meganet.push_subscription s where s.endpoint like '%check-push-%'
                 and (s.last_status <> 201 or s.last_sent_at is null or s.test_asked_at is not null or s.last_error is not null)), '');

  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('with nothing new and no test, the next run sends nothing', v = '[]', v::text);
end
$$;

-- ── 4. Arrivals ──────────────────────────────────────────────────────────────

do $$
declare v jsonb; x jsonb; n int; t text;
begin
  -- Each device last told an hour ago, and anything this database was
  -- already holding older than that.
  update meganet.push_subscription set told_through = now() - interval '1 hour' where endpoint like '%check-push-%';
  update auth.users set email_confirmed_at = now() - interval '2 hours'
   where email_confirmed_at > now() - interval '2 hours' and id::text not like '00000000-0000-4000-8000-00000000b00%';
  update meganet.ingest_token_request set requested_at = now() - interval '2 hours'
   where status = 'pending' and requested_at > now() - interval '2 hours';

  -- A council officer confirms their address half an hour ago.
  insert into auth.users (id, email, email_confirmed_at) values
    ('00000000-0000-4000-8000-00000000b011', 'new.person@push-council.test', now() - interval '30 minutes');
  v := pg_temp.due((select val from _k where k = 'vapid'));
  x := v -> 0;
  perform pg_temp.check_that('an account that confirmed since: every administrator''s device hears of it',
    pg_catalog.jsonb_array_length(v) = 4, v::text);
  perform pg_temp.check_that('…as an account waiting for approval, the badge the whole queue',
    x #>> '{payload,title}' = 'An account is waiting for your approval'
      and (x #>> '{payload,count}')::int = (meganet.push_waiting() ->> 'total')::int
      and x #>> '{payload,body}' like 'Waiting: %account%waiting for approval%'
      and x #>> '{payload,url}' = './?tab=admin' and x -> 'asked' = 'null', x::text);
  perform pg_temp.check_that('…and never says who it is: no address, no name',
    not exists (select 1 from pg_catalog.jsonb_array_elements(v) y
                 where (y -> 'payload')::text like '%@%' or (y -> 'payload')::text ilike '%new.person%'), v::text);
  t := (pg_temp.done(v, 201))::text;
  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('told once: the run after sends nothing about it', v = '[]', v::text);

  -- A base station asks, twenty minutes ago, calling itself something with a
  -- control character in it.
  update meganet.push_subscription set told_through = now() - interval '1 hour' where endpoint like '%check-push-%';
  insert into meganet.ingest_token_request (token_hash, code, label, requested_at, expires_at)
  values (repeat('ab', 32), 'BCDF-GHJK', E'Gatton\u0007 Pi', now() - interval '20 minutes', now() + interval '10 minutes');
  v := pg_temp.due((select val from _k where k = 'vapid'));
  select y into x from pg_catalog.jsonb_array_elements(v) y limit 1;
  perform pg_temp.check_that('a base station that asked: told as both kinds of news at once',
    x #>> '{payload,title}' = '2 new requests are waiting for you', x::text);
  perform pg_temp.check_that('…sent urgently, and not delivered at all after its half hour',
    x ->> 'urgency' = 'high' and (x ->> 'ttl')::int = 1800, x::text);

  -- The account is approved; only the base station is new.
  update meganet.app_user set status = 'approved', decided_at = now(), decided_by = 'check_push'
   where id = '00000000-0000-4000-8000-00000000b011';
  select (meganet.push_waiting() ->> 'accounts')::int into n;
  v := pg_temp.due((select val from _k where k = 'vapid'));
  x := v -> 0;
  perform pg_temp.check_that('a base station alone: named by its own label, cleaned, with its code',
    x #>> '{payload,title}' = 'A base station is asking for a token'
      and x #>> '{payload,body}' like '%a base station asking for a token: Gatton Pi, code BCDF-GHJK, until %', x::text);
  perform pg_temp.check_that('…and opens its approve form, as its QR code would — when it is all that waits',
    case when n = 0 and (meganet.push_waiting() ->> 'tokens')::int = 1
         then x #>> '{payload,url}' = './#pair=BCDF-GHJK' else x #>> '{payload,url}' = './?tab=admin' end, x::text);
  perform pg_temp.check_that('…the mark it reports is ten seconds behind, for a request still committing',
    (x ->> 'through')::timestamptz = now() - interval '10 seconds', x::text);

  -- An expired request is nobody's news.
  update meganet.push_subscription set told_through = now() - interval '1 hour' where endpoint like '%check-push-%';
  update meganet.ingest_token_request set expires_at = now() - interval '1 minute' where code = 'BCDF-GHJK';
  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('a request that has expired is not sent', v = '[]', v::text);
end
$$;

-- ── 5. Who is not told ───────────────────────────────────────────────────────

do $$
declare v jsonb;
begin
  update meganet.push_subscription set told_through = now() - interval '1 hour' where endpoint like '%check-push-%';
  insert into auth.users (id, email, email_confirmed_at) values
    ('00000000-0000-4000-8000-00000000b012', 'another@push-contract.test', now() - interval '5 minutes');

  update meganet.app_user set role = 'editor' where id = '00000000-0000-4000-8000-00000000b002';
  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('an administrator made an editor: their devices hear nothing from then on',
    pg_catalog.jsonb_array_length(v) = 2
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v) x
                       where x ->> 'endpoint' in ((select val from _k where k = 'moz'), (select val from _k where k = 'wns'))), v::text);
  update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-00000000b002';

  update meganet.app_user set status = 'declined' where id = '00000000-0000-4000-8000-00000000b002';
  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('…nor a declined one''s', pg_catalog.jsonb_array_length(v) = 2, v::text);
  update meganet.app_user set status = 'pending' where id = '00000000-0000-4000-8000-00000000b002';

  delete from meganet.editor_allow where entry = '@push-bureau.test';
  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('…nor anybody''s, once their address is off the allowlist (is_admin needs an editor)', v = '[]', v::text);
  insert into meganet.editor_allow (entry, note) values ('@push-bureau.test', 'check_push — rolled back');

  v := pg_temp.due((select val from _k where k = 'vapid2'));
  perform pg_temp.check_that('a new VAPID key: no device made with the old one is sent to', v = '[]', v::text);
  perform pg_temp.check_that('…and the key the page subscribes with is the new one',
    (select value from meganet.app_meta where key = 'push_public_key') = (select val from _k where k = 'vapid2'), '');
  perform meganet.push_due((select val from _k where k = 'vapid'));
end
$$;

-- ── 6. What the push services say ────────────────────────────────────────────

do $$
declare v jsonb; t text; r record;
begin
  update meganet.push_subscription set told_through = now() - interval '1 hour' where endpoint like '%check-push-%';
  v := pg_temp.due((select val from _k where k = 'vapid'));
  t := (meganet.push_done(pg_catalog.jsonb_build_array(
         pg_catalog.jsonb_build_object('id', v #> '{0,id}', 'status', 410, 'through', v #> '{0,through}'),
         pg_catalog.jsonb_build_object('id', v #> '{1,id}', 'status', 403, 'through', v #> '{1,through}',
                                       'error', 'HTTP 403 ' || repeat('x', 400)),
         pg_catalog.jsonb_build_object('id', v #> '{2,id}', 'status', 201, 'through', v #> '{2,through}'),
         pg_catalog.jsonb_build_object('id', v #> '{3,id}', 'through', v #> '{3,through}', 'error', 'connection reset'))))::text;
  perform pg_temp.check_that('the sender''s report: one sent, one gone, two failed', t::jsonb = '{"sent":1,"gone":1,"failed":2}', t);
  perform pg_temp.check_that('410: the push service says the subscription is gone, and so is its row',
    not exists (select 1 from meganet.push_subscription where id = (v #>> '{0,id}')::bigint), '');
  select * into r from meganet.push_subscription where id = (v #>> '{1,id}')::bigint;
  perform pg_temp.check_that('403: kept, the error said (cut to 300) and counted, and marked told all the same',
    r.last_status = 403 and pg_catalog.length(r.last_error) = 300 and r.failures = 1
      and r.told_through = (v #>> '{1,through}')::timestamptz, coalesce(r.last_error, '<null>'));
  select * into r from meganet.push_subscription where id = (v #>> '{3,id}')::bigint;
  perform pg_temp.check_that('no answer at all: said as such', r.last_status is null and r.last_error = 'connection reset' and r.failures = 1, '');

  v := pg_temp.due((select val from _k where k = 'vapid'));
  perform pg_temp.check_that('a failure is not retried every minute: the next run sends nothing', v = '[]', v::text);
end
$$;

-- ── 7. A test, a device off, a device handed on, ten at most ─────────────────

do $$
declare v text; n int; id_before bigint;
begin
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'), 'select meganet.push_test()::text');
  perform pg_temp.check_that('an administrator asks for a test on their devices', v::int >= 1, v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'member'), 'select meganet.push_test()::text');
  perform pg_temp.check_that('…a member cannot', v = 'ERROR 42501', v);
  v := (pg_temp.due((select val from _k where k = 'vapid')))::text;
  perform pg_temp.check_that('the next run sends the test, and to the asker''s devices only',
    pg_catalog.jsonb_array_length(v::jsonb) >= 1
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v::jsonb) x
                       join meganet.push_subscription s on s.id = (x ->> 'id')::bigint
                      where s.user_id <> '00000000-0000-4000-8000-00000000b001'
                         or x #>> '{payload,title}' <> 'Flood-Net notifications are on'), v);
  perform pg_temp.done(v::jsonb, 201);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'second'),
         pg_catalog.format('select meganet.push_unsubscribe(%L)::text', (select val from _k where k = 'fcm')));
  perform pg_temp.check_that('nobody turns off somebody else''s device', v = '0', v);
  select id into id_before from meganet.push_subscription where endpoint = (select val from _k where k = 'wns');
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'second'),
         pg_catalog.format('select meganet.push_unsubscribe(null, %s)::text', id_before));
  perform pg_temp.check_that('…and an administrator takes one of their own off by its place in the list', v = '1', v);
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         pg_catalog.format('select meganet.push_unsubscribe(%L)::text', (select val from _k where k = 'fcm')));
  perform pg_temp.check_that('…or this device by its endpoint', v = '1', v);

  -- The Mac the second administrator turned on is handed to the first.
  update meganet.push_subscription set told_through = now() - interval '3 hours' where endpoint = (select val from _k where k = 'moz');
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         pg_temp.sub_sql((select val from _k where k = 'moz'), (select val from _k where k = 'vapid'), 'Mac · Firefox'));
  perform pg_temp.check_that('a device turned on by another administrator becomes theirs, starting from now',
    (select user_id = '00000000-0000-4000-8000-00000000b001' and told_through = now()
       from meganet.push_subscription where endpoint = (select val from _k where k = 'moz')), v);

  for n in 1..11 loop
    perform pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
              pg_temp.sub_sql('https://web.push.apple.com/check-push-many-' || n, (select val from _k where k = 'vapid')));
  end loop;
  select count(*) into n from meganet.push_subscription where user_id = '00000000-0000-4000-8000-00000000b001';
  perform pg_temp.check_that('ten devices a person: the oldest give way', n = 10, n::text);
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
