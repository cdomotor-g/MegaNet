-- 0066_push_notifications.sql — An administrator's phone is told when somebody
-- is waiting for them: a notification, and the number of things waiting on
-- the app's icon. Web Push, to the devices an administrator turned it on for.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0066_push_notifications.sql
--
-- Why this file exists
-- ────────────────────
-- Two queues wait on an administrator and nobody else: accounts that have
-- confirmed an address the allowlist does not approve on its own (0062), and
-- base stations asking for an ingest token (0048) — which expire in thirty
-- minutes, with somebody standing at the station. 0062 emails the first, on a
-- five-minute job; nothing tells anybody about the second, and an email is
-- not what a phone in a pocket shows. The owner asked (October 2026) for a
-- notification and a count on the iPhone's home-screen icon, which a web app
-- has had since iOS 16.4: Web Push (RFC 8030/8291/8292) and the Badging API.
--
-- How it fits together
-- ────────────────────
--   1. The device. The Admin tab's Notifications panel (push.js) asks the
--      browser for a push subscription — an endpoint at Apple's, Google's,
--      Mozilla's or Microsoft's push service, and the two keys a message is
--      encrypted to — and hands it to push_subscribe(). Administrators only.
--      A device is one row: the endpoint is unique, and whoever turned it on
--      last on that device owns it.
--   2. The sender. The Worker (worker/push.js), on a schedule of its own,
--      calls push_due() with the project's secret key: which devices have
--      something to be told, and what. It encrypts each message to its
--      device, signs for the push service with Flood-Net's VAPID key, sends
--      it, and reports each answer to push_done(). Nothing in a browser can
--      call either.
--   3. What a device is told. Something that arrived since it was last told —
--      an account that confirmed its address, a base station that asked — and,
--      with it, how many are waiting in all: that number is the badge. A
--      device is told once per arrival, whatever happens to the delivery: a
--      message the push service would not take is said on the panel, not
--      retried every minute for ever. Nothing is sent when nothing arrived —
--      iOS shows every push as a notification, and takes the subscription
--      away from a site that sends one without — so a count that went down
--      (somebody else decided) is put right when the app is next opened.
--   4. A test. push_test() asks for one message to each of the caller's
--      devices on the next run, and a device just turned on gets one of its
--      own: the panel's way of proving the whole path, keys and all.
--   5. The key. The Worker says, each run, which VAPID public key it signs
--      with; push_due() keeps it in app_meta (push_public_key), which is where
--      the page reads it from, and only devices subscribed with that key are
--      sent to. A key that changes leaves the old devices waiting to be
--      turned on again, which the panel says — rather than messages Apple
--      refuses (403) for a key the subscription was not made with.
--   6. Whether the sender runs. push_due() also notes when it was last asked
--      (app_meta push_last_run, at most every ten minutes), so the panel can
--      say "not set up yet" and "the schedule has stopped" apart from "on".
--
-- Who
-- ───
--   * push_subscribe(), push_test(): administrators (meganet.is_admin()).
--   * push_unsubscribe(), push_mine(): any signed-in account, its own devices
--     only — somebody who stops being an administrator can still take theirs
--     off, and push_due() stops sending to them at once regardless.
--   * push_due(), push_done(), push_waiting(), push_trim(): service_role only.
--     push_due() hands out endpoints and keys; push_done() and push_trim()
--     delete rows.
--   * The table: RLS on, no policy and no grant — reached only through those.
--
-- What a notification says. Counts, and a base station's own label and code —
-- never an address or a name of a person: a notification is read on a lock
-- screen. The label is whatever the device said (request_ingest_token() is
-- anon's), so it is cut to 60 characters, its control characters and runs of
-- space made one space; a notification is plain text, so nothing in it is markup.
--
-- Depends on 0036 (is_admin), 0048 (ingest_token_request), 0062 (app_user's
-- status, email_allowed's part in approval). tools/check_push.sql proves it.


-- ── 1. The devices ───────────────────────────────────────────────────────────

create table if not exists meganet.push_subscription (
  id             bigint       generated always as identity primary key,
  user_id        uuid         not null references auth.users (id) on delete cascade,
  -- The push service's URL for this device. A capability: whoever holds it
  -- (and the VAPID key) can send to the device, so it leaves the database
  -- only to its own account and to the sender.
  endpoint       text         not null unique,
  -- The device's P-256 public key and auth secret (RFC 8291), base64url.
  p256dh         text         not null,
  auth           text         not null,
  -- The VAPID public key the subscription was made with (§5).
  vapid_key      text         not null,
  -- What the device calls itself, for the list: "iPhone · Safari".
  label          text         not null default 'This device',
  created_at     timestamptz  not null default now(),
  -- Everything that arrived up to here has been told to this device.
  told_through   timestamptz  not null default now(),
  -- A test asked for (push_test(), or turning it on) and not yet sent.
  test_asked_at  timestamptz,
  -- The push service's last answer, for the panel.
  last_sent_at   timestamptz,
  last_status    integer,
  last_error     text,
  failures       integer      not null default 0,

  -- The four push services a browser subscribes with: Apple's (Safari, every
  -- iPhone), Google's (Chrome, Edge on Android, Samsung Internet), Mozilla's
  -- and Microsoft's (Edge on Windows). Held here as well as in the Worker, so
  -- the sender never posts to a URL somebody made up.
  constraint push_subscription_endpoint check (
    pg_catalog.length(endpoint) <= 1024
    and endpoint ~ '^https://(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/[!-~]+$'),
  constraint push_subscription_p256dh check (p256dh ~ '^B[A-Za-z0-9_-]{86}$'),
  constraint push_subscription_auth   check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  constraint push_subscription_vapid  check (vapid_key ~ '^B[A-Za-z0-9_-]{86}$'),
  constraint push_subscription_label  check (pg_catalog.length(label) between 1 and 60 and label !~ '[[:cntrl:]]'),
  constraint push_subscription_error  check (last_error is null or pg_catalog.length(last_error) <= 300)
);

comment on table meganet.push_subscription is
  'One device an administrator turned notifications on for (0066): its Web Push endpoint and keys, what it has been told up to, and the push service''s last answer. RLS on, no policy and no grant: reached only through push_subscribe(), push_unsubscribe(), push_test(), push_mine(), and the sender''s push_due() and push_done().';
comment on column meganet.push_subscription.told_through is
  'Everything that arrived up to this moment has been told to the device (0066). Starts when it is turned on, so a new device hears only what arrives after.';

create index if not exists push_subscription_user on meganet.push_subscription (user_id);

alter table meganet.push_subscription enable row level security;


-- ── 2. What is waiting ───────────────────────────────────────────────────────

-- Both queues, counted the way their own lists count them: the accounts
-- whoami()'s approvals_waiting counts (0062), and the token requests the Admin
-- tab lists as waiting (0048 — pending and not past expires_at). With the one
-- request, when there is exactly one, for a notification to name.
create or replace function meganet.push_waiting()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with acc as (
    select count(*) as n
      from meganet.app_user a
      join auth.users u on u.id = a.id
     where a.status = 'pending'
       and u.email_confirmed_at is not null
       and not meganet.email_allowed(u.email)
  ), tok as (
    select count(*) as n,
           (pg_catalog.array_agg(pg_catalog.jsonb_build_object(
              'label', pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(t.label, '[[:cntrl:][:space:]]+', ' ', 'g')), 60),
              'code', t.code,
              'expires_at', t.expires_at) order by t.requested_at desc))[1] as newest
      from meganet.ingest_token_request t
     where t.status = 'pending'
       and t.expires_at > pg_catalog.now()
  )
  select pg_catalog.jsonb_build_object(
           'accounts', acc.n,
           'tokens',   tok.n,
           'total',    acc.n + tok.n,
           'one_token', case when tok.n = 1 then tok.newest end)
    from acc, tok;
$$;

comment on function meganet.push_waiting() is
  'How many accounts wait for an administrator (as whoami''s approvals_waiting counts them) and how many token requests (pending, not expired), their total — the badge — and the request itself when there is exactly one (0066). Internal: push_due() and push_mine().';


-- ── 3. A device turned on, off, tested ───────────────────────────────────────

-- Ten devices a person at most: the oldest go, which is the phone that was
-- replaced. A function of its own, called by push_subscribe(): the live
-- project's SQL connection would not take one request holding both the insert
-- and this delete, so they were applied apart, and the file says it the same.
create or replace function meganet.push_trim(p_user uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from meganet.push_subscription s
   where s.user_id = p_user
     and s.id not in (select x.id from meganet.push_subscription x
                       where x.user_id = p_user order by x.created_at desc, x.id desc limit 10);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function meganet.push_trim(uuid) is
  'Keep an account''s ten newest devices and delete the rest (0066). Internal: push_subscribe() only — never a browser role''s, since it takes any account.';

create or replace function meganet.push_subscribe(p_endpoint text, p_p256dh text, p_auth text,
                                                  p_key text, p_label text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key   text := (select m.value from meganet.app_meta m where m.key = 'push_public_key');
  v_label text := pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_label, ''), '[[:cntrl:][:space:]]+', ' ', 'g')), 60);
  v_id    bigint;
begin
  if auth.uid() is null or not meganet.is_admin() then
    raise exception 'only an administrator can have notifications sent to a device'
      using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'notifications are not set up on the server yet'
      using errcode = '55000',
            hint = 'The Worker needs its VAPID keys, and has to have run once — see docs/accounts.md, "Notifications on a phone".';
  end if;
  if p_key is distinct from v_key then
    raise exception 'the server''s notification key has changed since this page loaded — reload and turn them on again'
      using errcode = '22023';
  end if;
  if p_endpoint is null
     or pg_catalog.length(p_endpoint) > 1024
     or p_endpoint !~ '^https://(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/[!-~]+$' then
    raise exception 'that is not an endpoint at a push service Flood-Net sends to'
      using errcode = '22023';
  end if;
  if coalesce(p_p256dh, '') !~ '^B[A-Za-z0-9_-]{86}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception 'a subscription''s keys are a P-256 public key and a 16-byte secret, base64url'
      using errcode = '22023';
  end if;

  insert into meganet.push_subscription (user_id, endpoint, p256dh, auth, vapid_key, label, told_through, test_asked_at)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, v_key, coalesce(nullif(v_label, ''), 'This device'),
          pg_catalog.now(), pg_catalog.now())
  on conflict (endpoint) do update
     set user_id       = excluded.user_id,
         p256dh        = excluded.p256dh,
         auth          = excluded.auth,
         vapid_key     = excluded.vapid_key,
         label         = excluded.label,
         -- A device handed to another administrator starts from now; one turned
         -- on again by the same person keeps what it was told.
         told_through  = case when meganet.push_subscription.user_id = excluded.user_id
                              then meganet.push_subscription.told_through else excluded.told_through end,
         test_asked_at = excluded.test_asked_at,
         last_status   = null,
         last_error    = null,
         failures      = 0
  returning id into v_id;

  perform meganet.push_trim(auth.uid());
  return pg_catalog.jsonb_build_object('id', v_id);
end;
$$;

comment on function meganet.push_subscribe(text, text, text, text, text) is
  'Turn notifications on for this device (0066): its push endpoint (Apple, Google, Mozilla or Microsoft), its keys, the VAPID key it subscribed with (must be the server''s, app_meta push_public_key) and what it calls itself. Administrators only. The device owns one row whoever turned it on last; a test message goes on the next run; ten devices a person.';

create or replace function meganet.push_unsubscribe(p_endpoint text default null, p_id bigint default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'sign in to change your notifications' using errcode = '42501';
  end if;
  if p_endpoint is not null then
    delete from meganet.push_subscription s where s.user_id = auth.uid() and s.endpoint = p_endpoint;
  else
    delete from meganet.push_subscription s where s.user_id = auth.uid() and s.id = p_id;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function meganet.push_unsubscribe(text, bigint) is
  'Turn notifications off for one of the caller''s own devices, named by its endpoint (this device) or its id (one in the list — a lost phone) (0066). Any signed-in account. Answers how many went.';

create or replace function meganet.push_test()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not meganet.is_admin() then
    raise exception 'only an administrator can have notifications sent to a device'
      using errcode = '42501';
  end if;
  update meganet.push_subscription s
     set test_asked_at = pg_catalog.now()
   where s.user_id = auth.uid();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function meganet.push_test() is
  'Ask for a test message to every one of the caller''s devices on the sender''s next run (0066). Administrators only. Answers how many devices.';

-- What the panel draws: whether the server is set up and running, the key to
-- subscribe with, the caller's devices, and — to an administrator — what is
-- waiting, for the badge.
create or replace function meganet.push_mine()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else pg_catalog.jsonb_build_object(
    'key',      (select m.value from meganet.app_meta m where m.key = 'push_public_key'),
    -- As a timestamp, so it reaches the page in ISO 8601 as every other time
    -- does: the text Postgres writes ("2026-10-18 04:50:00+00") is not a date
    -- Safari will read.
    'last_run', (select m.value::timestamptz from meganet.app_meta m where m.key = 'push_last_run'),
    'is_admin', meganet.is_admin(),
    'waiting',  case when meganet.is_admin() then meganet.push_waiting() - 'one_token' end,
    'devices',  coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id',           s.id,
               'endpoint',     s.endpoint,
               'label',        s.label,
               'created_at',   s.created_at,
               'last_sent_at', s.last_sent_at,
               'last_status',  s.last_status,
               'last_error',   s.last_error,
               'failures',     s.failures,
               'test_waiting', s.test_asked_at is not null,
               'current_key',  s.vapid_key = (select m.value from meganet.app_meta m where m.key = 'push_public_key'))
             order by s.created_at desc)
        from meganet.push_subscription s
       where s.user_id = auth.uid()), '[]'::jsonb)) end;
$$;

comment on function meganet.push_mine() is
  'The Notifications panel''s state (0066): the VAPID key to subscribe with and when the sender last ran (both null until the Worker has), whether the caller is an administrator, what is waiting for one (accounts, tokens, total), and the caller''s own devices with the push service''s last answer. Null when signed out.';


-- ── 4. The sender's two calls ────────────────────────────────────────────────

-- Who is told, and what. One row per device that has something to hear: an
-- arrival since it was last told, or a test. Arrivals are counted up to ten
-- seconds ago rather than up to now: a request inserted by a transaction that
-- began before this one and commits after it carries a time this one cannot
-- see yet, and would otherwise fall behind the mark unseen. The next run, a
-- minute on, counts it.
create or replace function meganet.push_due(p_public_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_through  timestamptz := pg_catalog.now() - interval '10 seconds';
  v_wait     jsonb;
  v_accounts integer;
  v_tokens   integer;
  v_one      jsonb;
  v_parts    text[];
  v_summary  text;
  v_title    text;
  v_body     text;
  v_url      text;
  v_new      integer;
  v_out      jsonb := '[]'::jsonb;
  r          record;
begin
  if p_public_key is null or p_public_key !~ '^B[A-Za-z0-9_-]{86}$' then
    raise exception 'push_due: the VAPID public key, base64url (an uncompressed P-256 point)'
      using errcode = '22023';
  end if;

  insert into meganet.app_meta (key, value) values ('push_public_key', p_public_key)
  on conflict (key) do update set value = excluded.value
   where meganet.app_meta.value is distinct from excluded.value;
  insert into meganet.app_meta (key, value) values ('push_last_run', pg_catalog.now()::text)
  on conflict (key) do update set value = excluded.value
   where meganet.app_meta.updated_at < pg_catalog.now() - interval '10 minutes';

  v_wait     := meganet.push_waiting();
  v_accounts := (v_wait ->> 'accounts')::integer;
  v_tokens   := (v_wait ->> 'tokens')::integer;
  v_one      := v_wait -> 'one_token';

  -- What is waiting, in a line — the body of every message this run.
  v_parts := '{}';
  if v_accounts > 0 then
    v_parts := v_parts || (v_accounts || case when v_accounts = 1 then ' account' else ' accounts' end
                           || ' waiting for approval');
  end if;
  if v_tokens > 0 then
    v_parts := v_parts || (case when v_tokens = 1
                                then 'a base station asking for a token: ' || (v_one ->> 'label')
                                     || ', code ' || (v_one ->> 'code') || ', until '
                                     || pg_catalog.to_char((v_one ->> 'expires_at')::timestamptz at time zone 'Australia/Brisbane', 'HH24:MI')
                                else v_tokens || ' base stations asking for tokens' end);
  end if;
  v_summary := case when pg_catalog.cardinality(v_parts) = 0 then 'Nothing is waiting for you right now.'
                    else 'Waiting: ' || pg_catalog.array_to_string(v_parts, '; ') || '.' end;

  for r in
    select s.id, s.endpoint, s.p256dh, s.auth, s.test_asked_at,
           (select count(*)
              from meganet.app_user a2
              join auth.users u2 on u2.id = a2.id
             where a2.status = 'pending'
               and u2.email_confirmed_at > s.told_through
               and u2.email_confirmed_at <= v_through
               and not meganet.email_allowed(u2.email))::integer as new_accounts,
           (select count(*)
              from meganet.ingest_token_request t
             where t.status = 'pending'
               and t.expires_at > pg_catalog.now()
               and t.requested_at > s.told_through
               and t.requested_at <= v_through)::integer as new_tokens
      from meganet.push_subscription s
      join meganet.app_user a on a.id = s.user_id
      join auth.users u on u.id = s.user_id
     where s.vapid_key = p_public_key
       -- An administrator as is_admin() would say for their own session: an
       -- editor (a confirmed address on the allowlist, not declined or banned)
       -- whose app_user row says admin — asked now, not when they subscribed.
       and a.role = 'admin'
       and a.status <> 'declined'
       and u.email_confirmed_at is not null
       and (u.banned_until is null or u.banned_until <= pg_catalog.now())
       and meganet.email_allowed(u.email)
     order by s.id
     limit 200
  loop
    v_new := r.new_accounts + r.new_tokens;
    continue when v_new = 0 and r.test_asked_at is null;

    if v_new = 0 then
      v_title := 'Flood-Net notifications are on';
      v_body  := 'This device will be told when an account or a base station is waiting for an administrator. ' || v_summary;
    else
      v_title := case
        when r.new_tokens > 0 and r.new_accounts > 0 then v_new || ' new requests are waiting for you'
        when r.new_tokens = 1   then 'A base station is asking for a token'
        when r.new_tokens > 1   then r.new_tokens || ' base stations are asking for tokens'
        when r.new_accounts = 1 then 'An account is waiting for your approval'
        else r.new_accounts || ' accounts are waiting for your approval' end;
      v_body := v_summary;
    end if;
    -- The one request, when it is all there is, opens with its approve form
    -- (#pair=, as the base station's own QR code does); anything else, the tab.
    v_url := case when v_tokens = 1 and v_accounts = 0 and r.new_tokens = 1
                  then './#pair=' || (v_one ->> 'code') else './?tab=admin' end;

    v_out := v_out || pg_catalog.jsonb_build_object(
      'id',       r.id,
      'endpoint', r.endpoint,
      'p256dh',   r.p256dh,
      'auth',     r.auth,
      'through',  v_through,
      'asked',    r.test_asked_at,
      -- A base station's request lasts thirty minutes and somebody is standing
      -- at it: sent at once, and not delivered at all once it has gone.
      'urgency',  case when r.new_tokens > 0 then 'high' else 'normal' end,
      'ttl',      case when r.new_tokens > 0 then 1800 else 43200 end,
      'payload',  pg_catalog.jsonb_build_object(
                    'title', v_title,
                    'body',  v_body,
                    'count', v_accounts + v_tokens,
                    'url',   v_url,
                    'tag',   'floodnet-admin'));
  end loop;

  return v_out;
end;
$$;

comment on function meganet.push_due(text) is
  'The sender''s first call (0066, worker/push.js): records the VAPID public key it signs with and that it ran, then answers each device with something to hear — an arrival since it was last told, or a test — with its endpoint, keys, mark, and the message (title, body, the badge count, the page to open). Only administrators'' devices, subscribed with that key. service_role only.';

-- What the push services said. Every device reported is marked told up to the
-- run's mark whatever its answer, and its test is done; 404 and 410 are the
-- push service saying the subscription is gone, so the row goes too.
create or replace function meganet.push_done(p_report jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item   jsonb;
  v_status integer;
  v_sent   integer := 0;
  v_gone   integer := 0;
  v_failed integer := 0;
begin
  if pg_catalog.jsonb_typeof(p_report) is distinct from 'array' then
    raise exception 'push_done: a list of {id, status, through, asked, error}' using errcode = '22023';
  end if;
  for v_item in select x from pg_catalog.jsonb_array_elements(p_report) x loop
    continue when pg_catalog.jsonb_typeof(v_item -> 'id') is distinct from 'number';
    v_status := case when pg_catalog.jsonb_typeof(v_item -> 'status') = 'number'
                     then (v_item ->> 'status')::integer end;
    if v_status in (404, 410) then
      delete from meganet.push_subscription where id = (v_item ->> 'id')::bigint;
      v_gone := v_gone + 1;
      continue;
    end if;
    update meganet.push_subscription s
       set told_through  = greatest(s.told_through, coalesce((v_item ->> 'through')::timestamptz, s.told_through)),
           test_asked_at = case when s.test_asked_at is not distinct from (v_item ->> 'asked')::timestamptz
                                then null else s.test_asked_at end,
           last_sent_at  = case when v_status between 200 and 299 then pg_catalog.now() else s.last_sent_at end,
           last_status   = v_status,
           last_error    = case when v_status between 200 and 299 then null
                                else pg_catalog.left(coalesce(v_item ->> 'error', 'no answer'), 300) end,
           failures      = case when v_status between 200 and 299 then 0 else s.failures + 1 end
     where s.id = (v_item ->> 'id')::bigint;
    if v_status between 200 and 299 then v_sent := v_sent + 1; else v_failed := v_failed + 1; end if;
  end loop;
  return pg_catalog.jsonb_build_object('sent', v_sent, 'gone', v_gone, 'failed', v_failed);
end;
$$;

comment on function meganet.push_done(jsonb) is
  'The sender''s second call (0066): each device''s answer from its push service. Told up to the run''s mark whatever the answer and its test done; a 2xx noted as sent, anything else kept as the last error; 404 or 410 (the subscription is gone) deletes the row. service_role only.';


-- ── 5. Who may run what ──────────────────────────────────────────────────────

revoke all on table meganet.push_subscription                               from public;
revoke all on function meganet.push_waiting()                               from public;
revoke all on function meganet.push_trim(uuid)                              from public;
revoke all on function meganet.push_subscribe(text, text, text, text, text) from public;
revoke all on function meganet.push_unsubscribe(text, bigint)               from public;
revoke all on function meganet.push_test()                                  from public;
revoke all on function meganet.push_mine()                                  from public;
revoke all on function meganet.push_due(text)                               from public;
revoke all on function meganet.push_done(jsonb)                             from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Said out loud, whatever default privileges a project carries: the sender's
  -- two calls hand out and delete subscriptions, and the table is nobody's to
  -- read but through the functions.
  revoke all on table meganet.push_subscription from anon, authenticated;
  revoke execute on function meganet.push_waiting()     from anon, authenticated;
  revoke execute on function meganet.push_trim(uuid)    from anon, authenticated;
  revoke execute on function meganet.push_due(text)     from anon, authenticated;
  revoke execute on function meganet.push_done(jsonb)   from anon, authenticated;
  revoke execute on function meganet.push_subscribe(text, text, text, text, text) from anon;
  revoke execute on function meganet.push_unsubscribe(text, bigint)               from anon;
  revoke execute on function meganet.push_test()                                  from anon;
  revoke execute on function meganet.push_mine()                                  from anon;

  grant select, insert, update, delete on meganet.push_subscription to service_role;
  grant execute on function meganet.push_waiting()                               to service_role;
  grant execute on function meganet.push_trim(uuid)                              to service_role;
  grant execute on function meganet.push_subscribe(text, text, text, text, text) to authenticated, service_role;
  grant execute on function meganet.push_unsubscribe(text, bigint)               to authenticated, service_role;
  grant execute on function meganet.push_test()                                  to authenticated, service_role;
  grant execute on function meganet.push_mine()                                  to authenticated, service_role;
  grant execute on function meganet.push_due(text)                               to service_role;
  grant execute on function meganet.push_done(jsonb)                             to service_role;

  notify pgrst, 'reload schema';
end
$$;


-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  if pg_catalog.to_regclass('meganet.push_subscription') is null then
    raise exception '0066 did not take: meganet.push_subscription is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.push_subscription'::regclass) then
    raise exception '0066 did not take: RLS is off on meganet.push_subscription';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if pg_catalog.has_table_privilege('anon', 'meganet.push_subscription', 'select,insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.push_subscription', 'select,insert,update,delete') then
      raise exception '0066 did not take: a browser role can reach meganet.push_subscription directly';
    end if;
    foreach f in array array['meganet.push_waiting()', 'meganet.push_trim(uuid)', 'meganet.push_due(text)',
                             'meganet.push_done(jsonb)'] loop
      if pg_catalog.has_function_privilege('anon', f, 'execute')
         or pg_catalog.has_function_privilege('authenticated', f, 'execute') then
        raise exception '0066 did not take: a browser role may execute %', f;
      end if;
    end loop;
    foreach f in array array['meganet.push_subscribe(text, text, text, text, text)', 'meganet.push_unsubscribe(text, bigint)',
                             'meganet.push_test()', 'meganet.push_mine()'] loop
      if pg_catalog.has_function_privilege('anon', f, 'execute') then
        raise exception '0066 did not take: anon may execute %', f;
      end if;
    end loop;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 66 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '66')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
