-- 0113_base_station_mail.sql — The administrators are told when a base station
-- goes offline, and when it is back: an email each way.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0113_base_station_mail.sql
--
-- Why this file exists
-- ────────────────────
-- On the night of 10 November 2026 a base station lost its internet link at
-- 22:18 and was cut off until its operator switched it off and on at 06:27.
-- refresh_base_station_findings() (0059) had it down as quiet at 22:25 and
-- offline an hour later — a critical finding, open all night — and nobody
-- was told: a finding is something a person has to open a tab to see. It was
-- the fifth time in a fortnight that station had been offline, each one a
-- finding at the time. EPIC #214 has said so since October ("nothing tells
-- anyone"); #216 is the whole answer — subscriptions per person, a daily
-- digest, a push. This is its first slice, the one that night needed, built
-- from what is already here: the findings (0059), and the mail the accounts
-- already send through Resend from the database (0062's account_mail_one()).
--
-- Four decisions.
--
-- **1. Half an hour, not at once.** A base station that misses a few
-- check-ins is back by itself most times — a router restarting in the small
-- hours shows as four to fifteen minutes of quiet — and RPi ALERT 0.23 works
-- to get its own link back from the second minute (it joins its Wi-Fi again,
-- renews the connection, restarts its networking at fifteen minutes). A
-- message says the station's own first tries have not worked: thirty minutes
-- without a check-in, an open base-station-quiet finding behind it. The wait
-- is app_meta `base_station_mail_after_min` (5–1440).
--
-- **2. One message down, one back.** The finding a message went out about is
-- remembered (base_station_mail), so it is told once however long it stays
-- open, and when it clears — the station checking in again — one message
-- says so, with how long it was away and, where the station says, what
-- brought it back (RPi ALERT 0.23's `recovery`: it rejoined its Wi-Fi,
-- restarted its networking, rebooted itself, or somebody switched it off and
-- on). A finding that cleared because its token was revoked or the station
-- turned check-ins off gets no "back". Several stations in one run are one
-- message.
--
-- **3. A flapping link does not fill an inbox.** At most three "offline"
-- messages a station in any 24 hours; past that it is held until the day
-- has passed. Every one of its findings is still on the Base Stations tab.
--
-- **4. To the administrators, with one switch.** The same people 0062's
-- account mail goes to — role admin, a confirmed address, at mail_address()
-- (0100) — because base station findings are theirs alone to read (0059).
-- Who else should hear, and about what, is #216's subscriptions. Until then
-- one switch for all of them, on the Base Stations tab:
-- admin_base_station_mail_set(). On by default, and nothing is sent at all
-- until Vault holds `resend_api_key` (0062).
--
-- What a message says. A base station's label and when it was last heard —
-- what an administrator sees on the tab — never an address of the station or
-- of a person.
--
-- Depends on 0049 (base stations), 0059 and 0094 (findings), 0062 (the mail),
-- 0100 (where a person's mail goes). tools/check_base_station_mail.sql proves it.

-- ── What was told ────────────────────────────────────────────────────────────

create table if not exists meganet.base_station_mail (
  -- The base-station-quiet finding the "offline" message was about.
  finding_id       bigint       primary key references meganet.health_finding (id) on delete cascade,
  ingest_token_id  bigint       not null references meganet.ingest_token (id) on delete cascade,
  down_told_at     timestamptz  not null,
  -- When "it is back" was said — or decided not worth saying (the finding
  -- cleared for another reason, or long ago).
  up_told_at       timestamptz,

  constraint base_station_mail_order check (up_told_at is null or up_told_at >= down_told_at)
);

comment on table meganet.base_station_mail is
  'Which base-station-quiet findings the administrators were emailed about, and when they were told it was back (0113). One row per finding told. RLS on, no policy and no grant: written by send_base_station_mail(), read through admin_base_station_mail().';

create index if not exists base_station_mail_token_idx
  on meganet.base_station_mail (ingest_token_id, down_told_at);
create index if not exists base_station_mail_waiting_idx
  on meganet.base_station_mail (finding_id) where up_told_at is null;

alter table meganet.base_station_mail enable row level security;

-- ── The two settings ─────────────────────────────────────────────────────────

create or replace function meganet.base_station_mail_on()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.value from meganet.app_meta m where m.key = 'base_station_mail'), 'on') <> 'off';
$$;

create or replace function meganet.base_station_mail_after()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select least(1440, greatest(5, coalesce(
    (select case when m.value ~ '^[0-9]{1,5}$' then m.value::integer end
       from meganet.app_meta m where m.key = 'base_station_mail_after_min'), 30)));
$$;

comment on function meganet.base_station_mail_on() is
  'Whether the administrators are emailed about base stations going offline (0113): app_meta base_station_mail, on unless it says off. Internal.';
comment on function meganet.base_station_mail_after() is
  'How many minutes without a check-in before the administrators are told (0113): app_meta base_station_mail_after_min, 30 unless set, held to 5–1440. Internal.';

-- ── What a station's last status says about its link, in a few words ─────────

-- "on Wi-Fi" / "on Ethernet" from the interfaces it listed, and what it does
-- by itself to get back (RPi ALERT 0.23's recovery.mode).
create or replace function meganet.base_station_link_words(p_status jsonb, p_version text)
returns text
language sql
immutable
set search_path = ''
as $$
  with a as (
    select bool_or(x ->> 'iface' ~ '^wl') as wifi, bool_or(x ->> 'iface' ~ '^(eth|en)') as wired
      from pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(p_status -> 'host' -> 'addresses') = 'array'
                  then p_status -> 'host' -> 'addresses' else '[]'::jsonb end) x
  )
  select pg_catalog.concat_ws(' ',
    case when a.wired then 'It is on Ethernet.' when a.wifi then 'It is on Wi-Fi.' end,
    case p_status -> 'recovery' ->> 'mode'
      when 'full'    then 'It tries to get back by itself: it joins its network again, restarts its networking, and reboots itself after 45 minutes.'
      when 'network' then 'It tries to get back by itself — joining its network again and restarting its networking — but is set never to reboot itself.'
      when 'off'     then 'Getting back by itself is turned off on it.'
      else 'Its software' || coalesce(' (' || nullif(pg_catalog.btrim(p_version), '') || ')', '') || ' does not try to get its link back by itself; RPi ALERT 0.23 and later do.'
    end)
    from a;
$$;

comment on function meganet.base_station_link_words(jsonb, text) is
  'A sentence or two for the offline message (0113): whether the station is on Wi-Fi or Ethernet, and what it does by itself to get back, from its last whole status. Internal.';

-- What brought it back, as the station itself tells it (recovery.outages[0].how).
create or replace function meganet.base_station_back_words(p_status jsonb, p_cleared timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    -- Its newest outage, if it ended about when the finding cleared.
    when o is null or pg_catalog.jsonb_typeof(o -> 'ended') <> 'number'
      or pg_catalog.to_timestamp((o ->> 'ended')::double precision / 1000) not between p_cleared - interval '30 minutes' and p_cleared + interval '10 minutes'
      then ''
    else case o ->> 'how'
      when 'wifi-rejoin'   then ' It says it got back by joining its Wi-Fi network again.'
      when 'net-reconnect' then ' It says it got back by renewing its network connection.'
      when 'net-restart'   then ' It says it got back by restarting its networking.'
      when 'restart-agent' then ' It says it got back by restarting its own software.'
      when 'reboot'        then ' It says it got back by rebooting itself.'
      when 'power'         then ' It says somebody switched it off and on.'
      when 'restart'       then ' It says its software was restarted.'
      else ' It says its link came back without it doing anything.'
    end
  end
  from (select case when pg_catalog.jsonb_typeof(p_status -> 'recovery' -> 'outages') = 'array'
                    then p_status -> 'recovery' -> 'outages' -> 0 end as o) s;
$$;

comment on function meganet.base_station_back_words(jsonb, timestamptz) is
  'What brought a base station back, for the "it is back" message (0113): its own newest outage record (RPi ALERT 0.23''s recovery), when that ended about when the finding cleared; else nothing. Internal.';

-- ── The sender ───────────────────────────────────────────────────────────────

create or replace function meganet.send_base_station_mail(p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_site    text := coalesce((select m.value from meganet.app_meta m where m.key = 'site_url'),
                             'https://floodwarning.net/');
  v_after   integer := meganet.base_station_mail_after();
  v_admins  text[];
  v_ids     bigint[];
  v_lines   text;
  v_first   text;
  v_n       integer;
  v_held    integer := 0;
  v_down    integer := 0;
  v_back    integer := 0;
begin
  -- Once at a time, as the findings' own run is.
  if not pg_catalog.pg_try_advisory_xact_lock(5900216) then
    return pg_catalog.jsonb_build_object('skipped', 'another run is under way');
  end if;
  if not meganet.base_station_mail_on() then
    return pg_catalog.jsonb_build_object('off', true);
  end if;

  select pg_catalog.array_agg(distinct meganet.mail_address(a.id))
    into v_admins
    from meganet.app_user a
    join auth.users u on u.id = a.id
   where a.role = 'admin'
     and a.status <> 'declined'
     and u.email_confirmed_at is not null;

  -- 1. Offline: an open finding nobody was told about, its station unheard
  --    for the wait — and not its fourth message in a day.
  with due as (
    select h.id, h.ingest_token_id,
           coalesce(nullif(pg_catalog.btrim(t.label), ''), 'Ingest point ' || h.ingest_token_id) as label,
           b.last_seen_at, b.status, b.version,
           (select count(*) from meganet.base_station_mail m
             where m.ingest_token_id = h.ingest_token_id
               and m.down_told_at > p_now - interval '24 hours') as told_today
      from meganet.health_finding h
      join meganet.base_station b on b.ingest_token_id = h.ingest_token_id
      join meganet.ingest_token t on t.id = h.ingest_token_id
     where h.source = 'base-stations' and h.kind = 'base-station-quiet' and h.cleared_at is null
       and b.last_seen_at <= p_now - v_after * interval '1 minute'
       and not exists (select 1 from meganet.base_station_mail m where m.finding_id = h.id)
  )
  select pg_catalog.array_agg(d.id order by d.last_seen_at) filter (where d.told_today < 3),
         pg_catalog.string_agg(
           '  • ' || d.label || ' — last heard '
             || pg_catalog.to_char(d.last_seen_at at time zone 'Australia/Brisbane', 'DD Mon HH24:MI')
             || ' (' || meganet.health_span(extract(epoch from p_now - d.last_seen_at)) || ' ago). '
             || meganet.base_station_link_words(d.status, d.version),
           E'\n' order by d.last_seen_at) filter (where d.told_today < 3),
         pg_catalog.min(d.label) filter (where d.told_today < 3),
         count(*) filter (where d.told_today < 3),
         count(*) filter (where d.told_today >= 3)
    into v_ids, v_lines, v_first, v_n, v_held
    from due d;

  if v_n > 0 and meganet.account_mail_one(
       v_admins,
       case when v_n = 1 then 'Flood-Net: ' || v_first || ' is offline'
            else 'Flood-Net: ' || v_n || ' base stations are offline' end,
       case when v_n = 1 then 'This base station has stopped checking in:'
            else 'These base stations have stopped checking in:' end
         || E'\n\n' || v_lines || E'\n\n'
         || 'What only its receivers hear is not arriving while it is away. A base station that is still running '
         || 'keeps what it hears and sends it when it is back.' || E'\n\n'
         || 'Base Stations: ' || v_site || '?tab=basestations' || E'\n\n'
         || 'You will be told when it is back. These messages go to Flood-Net''s administrators once a base station '
         || 'has not been heard from for ' || v_after || ' minutes; an administrator can turn them off on the Base Stations tab.') then
    insert into meganet.base_station_mail (finding_id, ingest_token_id, down_told_at)
    select h.id, h.ingest_token_id, pg_catalog.clock_timestamp()
      from meganet.health_finding h
     where h.id = any (v_ids)
    on conflict (finding_id) do nothing;
    v_down := v_n;
  end if;

  -- 2. Back: a finding that was told about has cleared. Said only of a
  --    station that is checking in again, and only within a day of it — one
  --    that cleared because its token was revoked, or while these messages
  --    were off, is closed without a word.
  update meganet.base_station_mail m
     set up_told_at = pg_catalog.clock_timestamp()
    from meganet.health_finding h
    left join meganet.base_station b on b.ingest_token_id = h.ingest_token_id
   where h.id = m.finding_id and m.up_told_at is null and h.cleared_at is not null
     and (h.cleared_at < p_now - interval '24 hours'
          or b.ingest_token_id is null
          or meganet.base_station_state(b.mode, b.idle_s, b.last_seen_at, p_now) <> 'online');

  with due as (
    select m.finding_id,
           coalesce(nullif(pg_catalog.btrim(t.label), ''), 'Ingest point ' || h.ingest_token_id) as label,
           h.cleared_at, b.status,
           coalesce(case when h.evidence ->> 'last_seen_at' ~ '^\d{4}-\d\d-\d\d' then (h.evidence ->> 'last_seen_at')::timestamptz end, h.first_seen) as away_from
      from meganet.base_station_mail m
      join meganet.health_finding h on h.id = m.finding_id
      join meganet.base_station b on b.ingest_token_id = h.ingest_token_id
      join meganet.ingest_token t on t.id = h.ingest_token_id
     where m.up_told_at is null and h.cleared_at is not null
  )
  select pg_catalog.array_agg(d.finding_id order by d.cleared_at),
         pg_catalog.string_agg(
           '  • ' || d.label || ' — checking in again, after ' || meganet.health_span(extract(epoch from d.cleared_at - d.away_from))
             || ' away (last heard ' || pg_catalog.to_char(d.away_from at time zone 'Australia/Brisbane', 'DD Mon HH24:MI') || ').'
             || meganet.base_station_back_words(d.status, d.cleared_at),
           E'\n' order by d.cleared_at),
         pg_catalog.min(d.label),
         count(*)
    into v_ids, v_lines, v_first, v_n
    from due d;

  if v_n > 0 and meganet.account_mail_one(
       v_admins,
       case when v_n = 1 then 'Flood-Net: ' || v_first || ' is back'
            else 'Flood-Net: ' || v_n || ' base stations are back' end,
       case when v_n = 1 then 'This base station is checking in again:'
            else 'These base stations are checking in again:' end
         || E'\n\n' || v_lines || E'\n\n'
         || 'What it kept while it was away is sent as soon as it is back; the Base Stations tab shows what is still waiting.' || E'\n\n'
         || 'Base Stations: ' || v_site || '?tab=basestations') then
    update meganet.base_station_mail set up_told_at = pg_catalog.clock_timestamp() where finding_id = any (v_ids);
    v_back := v_n;
  end if;

  return pg_catalog.jsonb_build_object('down', v_down, 'back', v_back, 'held', v_held);
end;
$$;

comment on function meganet.send_base_station_mail(timestamptz) is
  'Email the administrators about base stations that have not checked in for base_station_mail_after() minutes — once per finding, at most three a station a day — and again when one is back (0113). At mail_address() (0100), through account_mail_one() (0062): nothing is sent, and nothing remembered, until Vault holds resend_api_key. pg_cron every five minutes; the owner and service_role only.';

-- ── The switch, for the Base Stations tab ────────────────────────────────────

create or replace function meganet.admin_base_station_mail()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ready boolean := false;
begin
  perform meganet.admin_require();
  -- Can a message go at all? The same two things account_mail_one() asks for,
  -- without reading the key.
  if pg_catalog.to_regclass('vault.secrets') is not null
     and pg_catalog.to_regprocedure('extensions.http(extensions.http_request)') is not null then
    execute 'select exists (select 1 from vault.secrets where name = $1)' into v_ready using 'resend_api_key';
  end if;
  return pg_catalog.jsonb_build_object(
    'on',        meganet.base_station_mail_on(),
    'after_min', meganet.base_station_mail_after(),
    'ready',     coalesce(v_ready, false),
    'people',    (select count(distinct meganet.mail_address(a.id))
                    from meganet.app_user a join auth.users u on u.id = a.id
                   where a.role = 'admin' and a.status <> 'declined' and u.email_confirmed_at is not null),
    'recent',    coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', r.ingest_token_id, 'label', r.label, 'down_told_at', r.down_told_at, 'up_told_at', r.up_told_at,
               'cleared_at', r.cleared_at) order by r.down_told_at desc)
        from (select m.ingest_token_id, m.down_told_at, m.up_told_at, h.cleared_at,
                     coalesce(nullif(pg_catalog.btrim(t.label), ''), 'Ingest point ' || m.ingest_token_id) as label
                from meganet.base_station_mail m
                join meganet.health_finding h on h.id = m.finding_id
                join meganet.ingest_token t on t.id = m.ingest_token_id
               order by m.down_told_at desc
               limit 10) r), '[]'::jsonb));
end;
$$;

create or replace function meganet.admin_base_station_mail_set(p_on boolean default null, p_after_min integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  if p_after_min is not null and (p_after_min < 5 or p_after_min > 1440) then
    raise exception 'the wait is between 5 minutes and a day (1440)' using errcode = '22023';
  end if;
  if p_on is not null then
    insert into meganet.app_meta (key, value) values ('base_station_mail', case when p_on then 'on' else 'off' end)
    on conflict (key) do update set value = excluded.value;
  end if;
  if p_after_min is not null then
    insert into meganet.app_meta (key, value) values ('base_station_mail_after_min', p_after_min::text)
    on conflict (key) do update set value = excluded.value;
  end if;
  return meganet.admin_base_station_mail();
end;
$$;

comment on function meganet.admin_base_station_mail() is
  'For the Base Stations tab (0113): whether the administrators are emailed when a base station goes offline, after how many minutes, whether a message can be sent at all (the mail key is set), how many people it goes to, and the last ten told. Administrators only.';
comment on function meganet.admin_base_station_mail_set(boolean, integer) is
  'Turn the offline emails on or off, or change the wait (5–1440 minutes); null leaves either as it is (0113). Administrators only; answers admin_base_station_mail().';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.base_station_mail_on() from public;
revoke all on function meganet.base_station_mail_after() from public;
revoke all on function meganet.base_station_link_words(jsonb, text) from public;
revoke all on function meganet.base_station_back_words(jsonb, timestamptz) from public;
revoke all on function meganet.send_base_station_mail(timestamptz) from public;
revoke all on function meganet.admin_base_station_mail() from public;
revoke all on function meganet.admin_base_station_mail_set(boolean, integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- authenticated, not anon: admin_require() asks as well. The sender is the
  -- scheduler's and the secret key's.
  grant execute on function meganet.admin_base_station_mail() to authenticated, service_role;
  grant execute on function meganet.admin_base_station_mail_set(boolean, integer) to authenticated, service_role;
  grant execute on function meganet.send_base_station_mail(timestamptz) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── The schedule ─────────────────────────────────────────────────────────────
-- Every five minutes, two minutes after the findings' own run (0059's
-- meganet-base-station-health, on the fives), so a message is about what that
-- run just found. Where there is no pg_cron (CI's postgres:16) it says so and
-- carries on.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.send_base_station_mail() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-base-station-mail', '2-57/5 * * * *', 'select meganet.send_base_station_mail()');
    raise notice 'meganet.send_base_station_mail() runs every five minutes (pg_cron job meganet-base-station-mail).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): nobody will be emailed about an offline base station until it is.', sqlerrm;
  end;
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.base_station_mail') is null
     or pg_catalog.to_regprocedure('meganet.send_base_station_mail(timestamptz)') is null
     or pg_catalog.to_regprocedure('meganet.admin_base_station_mail()') is null
     or pg_catalog.to_regprocedure('meganet.admin_base_station_mail_set(boolean, integer)') is null then
    raise exception '0113 did not take: the table or a function is missing';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.send_base_station_mail(timestamptz)', 'execute')
     or pg_catalog.has_function_privilege('public', 'meganet.admin_base_station_mail()', 'execute')
     or pg_catalog.has_function_privilege('public', 'meganet.admin_base_station_mail_set(boolean, integer)', 'execute') then
    raise exception '0113 did not take: public may run a function';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 113 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '113')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
