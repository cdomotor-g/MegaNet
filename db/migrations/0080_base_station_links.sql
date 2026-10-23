-- 0080_base_station_links.sql — A base station's connection over time: when
-- it dropped out and came back, whether it restarted meanwhile, and when the
-- network it calls from or its route to Flood-Net changed. For the Admin tab's
-- Base station connections card and its log.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0080_base_station_links.sql
--
-- Why this file exists
-- ────────────────────
-- base_station (0049) holds what a station said at its last check-in and
-- nothing about the time between. On 24 Oct 2026 a phone on the same Wi-Fi as
-- 18 Bateson got no answer from Flood-Net at 03:51, and finding out why took
-- the auth log, Supabase's edge log and the station's readings side by side: no
-- check-in from 03:45 to 03:54, its public address different after, and the
-- same nine minutes at about the same hour on the 17th and the 21st. Edge logs
-- go after a few days and are not something an administrator can read. This
-- keeps that record where one can.
--
-- Five decisions.
--
-- **1. Written by a trigger on base_station, not by base_station_checkin().**
-- The check-in (0049, last redefined by 0068) upserts base_station once a
-- check-in; a BEFORE trigger on that row sees the last check-in (OLD) and this
-- one (NEW) side by side, which is all a gap is, and leaves the check-in's own
-- function as it was. Each part of it runs in its own exception block: the
-- record of a connection is never the reason a check-in fails.
--
-- **2. A dropout is base_station_state()'s own line.** A check-in more than
-- three idle periods, and at least three minutes, after the one before — the
-- point 0059 stops calling a station online — closes a gap from the last
-- check-in to this one. The heartbeat this check-in carried says what kind:
-- the computer's uptime shorter than the gap is a restart (power, or a
-- reboot); only the software's (agent_up) is an agent restart; neither is a
-- dropout — the computer stayed up and could not get through. A station that
-- had said `off` is not gapped: it said it would stop.
--
-- **3. The address is kept shortened.** The full public address is not
-- stored. What is: its block — an IPv4 address's first two numbers
-- (168.140.x.x), an IPv6 address's first two groups (2406:2d40::/32), enough to
-- tell one provider's range from another's — and a fingerprint, keyed with the
-- token's own hash, of the part that names the connection: the whole IPv4
-- address, the IPv6 /64 (whose host half a computer changes every day by
-- design). A new fingerprint for the same family is an `address` event. IPv4
-- and IPv6 are followed separately, so a station that uses both is not seen to
-- change every time it picks the other.
--
-- **4. The route.** Through floodwarning.net (worker/index.js forwards
-- /api/db/* — the Worker's subrequest carries Cloudflare's CF-Worker header and
-- comes from Cloudflare's Workers range) or straight to Supabase. A change is a
-- `route` event: on 23 Oct 2026 18 Bateson's readings moved from one to the
-- other with no gap, and read without it, the edge log looked like an outage.
--
-- **5. The time before this file, from the readings.** A station's receptions
-- (0047) carry when each was heard and when it arrived. A gap of five minutes
-- or more in arrivals, with readings heard inside it, is a dropout the station
-- rode out by holding what it heard (`detail.held`); with none, it is `quiet` —
-- nothing heard and nothing sent, cause unknown. Back as far as receptions are
-- kept (0073), once, marked `source: readings`.
--
-- Who can read it: administrators, through admin_base_station_links(). RLS on,
-- no policy and no grant, as for base_station.

-- ── The record ───────────────────────────────────────────────────────────────

create table if not exists meganet.base_station_link (
  id               bigint       generated always as identity primary key,
  ingest_token_id  bigint       not null references meganet.ingest_token (id),
  -- dropout, restart, agent, quiet: a gap, from started_at to ended_at.
  -- address, route: a change, at started_at, from addr_from to addr_to.
  kind             text         not null,
  started_at       timestamptz  not null,
  ended_at         timestamptz,
  seconds          integer,
  addr_from        text,
  addr_to          text,
  -- source (checkins or readings), up_s, agent_up_s, held, family, route.
  detail           jsonb        not null default '{}'::jsonb,

  constraint base_station_link_kind   check (kind in ('dropout', 'restart', 'agent', 'quiet', 'address', 'route')),
  constraint base_station_link_detail check (pg_catalog.jsonb_typeof(detail) = 'object'
                                             and pg_catalog.octet_length(detail::text) <= 2048),
  constraint base_station_link_addr   check (pg_catalog.length(coalesce(addr_from, '')) <= 64
                                             and pg_catalog.length(coalesce(addr_to, '')) <= 64)
);

create index if not exists base_station_link_token_at
  on meganet.base_station_link (ingest_token_id, started_at desc);

comment on table meganet.base_station_link is
  'A base station''s connection over time (0080): gaps in its check-ins (dropout, restart, agent; quiet from readings before 0080) and changes of public address block or route. The full address is never stored. RLS on, no policy and no grant: written by the base_station_link_note() trigger and 0080''s backfill, read through admin_base_station_links().';

alter table meganet.base_station_link enable row level security;

-- Where the station last called from: per family its shortened block, the
-- fingerprint and since when; the route; which family it used last.
alter table meganet.base_station add column if not exists net jsonb;

comment on column meganet.base_station.net is
  'Where the station last called from (0080): {v4|v6: {addr, key, since}, route, family, at}. addr is the block only (decision 3); key a fingerprint keyed with the token''s hash. Written by base_station_link_note(); admin_base_station_links() never returns key.';

-- ── The trigger ──────────────────────────────────────────────────────────────

create or replace function meganet.base_station_link_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gap    numeric;
  v_up     numeric;
  v_agent  numeric;
  v_kind   text;
  v_h      jsonb;
  v_ip     inet;
  v_cf     inet;
  v_fam    text;
  v_mask   text;
  v_salt   text;
  v_key    text;
  v_route  text;
  v_net    jsonb;
  v_old    jsonb;
begin
  -- A check-in counts itself; an administrator watching (0049) does not.
  if tg_op = 'UPDATE' and new.checkins is not distinct from old.checkins then
    return new;
  end if;

  -- Decision 2: the gap since the last check-in.
  begin
    if tg_op = 'UPDATE' and old.mode <> 'off' then
      v_gap := extract(epoch from new.last_seen_at - old.last_seen_at);
      if v_gap > greatest(180, 3 * old.idle_s) then
        if new.beat_at is not distinct from new.last_seen_at then
          v_up    := case when pg_catalog.jsonb_typeof(new.beat -> 'up') = 'number' then (new.beat ->> 'up')::numeric end;
          v_agent := case when pg_catalog.jsonb_typeof(new.beat -> 'agent_up') = 'number' then (new.beat ->> 'agent_up')::numeric end;
        end if;
        v_kind := case when v_up < v_gap then 'restart' when v_agent < v_gap then 'agent' else 'dropout' end;
        insert into meganet.base_station_link (ingest_token_id, kind, started_at, ended_at, seconds, detail)
        values (new.ingest_token_id, v_kind, old.last_seen_at, new.last_seen_at, pg_catalog.round(v_gap)::integer,
                pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                  'source', 'checkins', 'up_s', pg_catalog.round(v_up), 'agent_up_s', pg_catalog.round(v_agent))));
        -- Housekeeping, this station's own: a year and a bit.
        delete from meganet.base_station_link l
         where l.ingest_token_id = new.ingest_token_id and l.started_at < pg_catalog.now() - interval '400 days';
      end if;
    end if;
  exception when others then
    null;
  end;

  -- Decisions 3 and 4: where it called from, and which way.
  begin
    v_h := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
    if v_h is not null then
      v_ip := nullif(pg_catalog.btrim(pg_catalog.split_part(coalesce(v_h ->> 'x-forwarded-for', ''), ',', 1)), '')::inet;
      v_cf := nullif(pg_catalog.btrim(coalesce(v_h ->> 'cf-connecting-ip', '')), '')::inet;
      v_ip := coalesce(v_ip, v_cf);
      v_route := case when coalesce(v_h ->> 'cf-worker', '') <> '' or v_cf <<= '2a06:98c0::/29'::inet
                      then 'floodwarning.net' else 'direct' end;
    end if;
    if v_ip is not null then
      v_fam := case when pg_catalog.family(v_ip) = 4 then 'v4' else 'v6' end;
      v_mask := case v_fam
                  when 'v4' then pg_catalog.split_part(pg_catalog.host(v_ip), '.', 1) || '.'
                              || pg_catalog.split_part(pg_catalog.host(v_ip), '.', 2) || '.x.x'
                  else pg_catalog.host(pg_catalog.network(pg_catalog.set_masklen(v_ip, 32))) || '/32' end;
      select t.token_hash into v_salt from meganet.ingest_token t where t.id = new.ingest_token_id;
      v_key := pg_catalog.md5(coalesce(v_salt, '') || '|' || case v_fam
                 when 'v4' then pg_catalog.host(v_ip)
                 else pg_catalog.host(pg_catalog.network(pg_catalog.set_masklen(v_ip, 64))) end);
      v_net := coalesce(case when tg_op = 'UPDATE' then old.net end, '{}'::jsonb);
      v_old := v_net -> v_fam;
      if v_old is not null and v_old ->> 'key' is distinct from v_key then
        insert into meganet.base_station_link (ingest_token_id, kind, started_at, addr_from, addr_to, detail)
        values (new.ingest_token_id, 'address', new.last_seen_at, v_old ->> 'addr', v_mask,
                pg_catalog.jsonb_build_object('source', 'checkins', 'family', v_fam, 'route', v_route));
      end if;
      if v_net ->> 'route' is not null and v_net ->> 'route' <> v_route then
        insert into meganet.base_station_link (ingest_token_id, kind, started_at, addr_from, addr_to, detail)
        values (new.ingest_token_id, 'route', new.last_seen_at, v_net ->> 'route', v_route,
                pg_catalog.jsonb_build_object('source', 'checkins', 'family', v_fam));
      end if;
      new.net := v_net || pg_catalog.jsonb_build_object(
        v_fam,    pg_catalog.jsonb_build_object(
                    'addr',  v_mask,
                    'key',   v_key,
                    'since', case when v_old ->> 'key' = v_key then v_old -> 'since'
                                  else pg_catalog.to_jsonb(new.last_seen_at) end),
        'route',  v_route,
        'family', v_fam,
        'at',     new.last_seen_at);
    end if;
  exception when others then
    null;
  end;

  return new;
end;
$$;

comment on function meganet.base_station_link_note() is
  'BEFORE INSERT OR UPDATE on base_station (0080): on a check-in, records a gap since the last one (dropout, restart or agent, by the heartbeat''s uptime) and a change of public address block or route in base_station_link, and keeps base_station.net. Never fails a check-in.';

drop trigger if exists base_station_link_note on meganet.base_station;
create trigger base_station_link_note
  before insert or update on meganet.base_station
  for each row execute function meganet.base_station_link_note();

-- ── Decision 5: the time before this file ────────────────────────────────────

do $$
begin
  if exists (select 1 from meganet.base_station_link l where l.detail ->> 'source' = 'readings') then
    return;
  end if;
  insert into meganet.base_station_link (ingest_token_id, kind, started_at, ended_at, seconds, detail)
  select g.tok,
         case when h.held > 0 then 'dropout' else 'quiet' end,
         g.prev, g.received_at,
         pg_catalog.round(extract(epoch from g.received_at - g.prev))::integer,
         pg_catalog.jsonb_build_object('source', 'readings', 'held', h.held)
    from (
      select r.ingest_token_id as tok, r.received_at,
             pg_catalog.lag(r.received_at) over (partition by r.ingest_token_id order by r.received_at) as prev
        from meganet.reception r
       where r.ingest_token_id in (select b.ingest_token_id from meganet.base_station b)
    ) g
    cross join lateral (
      select pg_catalog.count(*) as held
        from meganet.reception r2
       where r2.ingest_token_id = g.tok
         and r2.heard_at > g.prev + interval '30 seconds'
         and r2.heard_at < g.received_at - interval '30 seconds'
    ) h
   where g.received_at - g.prev >= interval '5 minutes';
end
$$;

-- ── What the Admin tab reads ─────────────────────────────────────────────────

create or replace function meganet.admin_base_station_links(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now  timestamptz := pg_catalog.now();
  v_days integer     := greatest(1, least(365, coalesce(p_days, 30)));
  v_from timestamptz := pg_catalog.now() - v_days * interval '1 day';
begin
  perform meganet.admin_require();
  return pg_catalog.jsonb_build_object(
    'now',  v_now,
    'days', v_days,
    'from', v_from,
    'stations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id',              t.id,
               'label',           t.label,
               'host_station_id', t.host_station_id,
               'app',             b.app,
               'version',         b.version,
               'mode',            b.mode,
               'idle_s',          b.idle_s,
               'first_seen_at',   b.first_seen_at,
               'last_seen_at',    b.last_seen_at,
               'checkins',        b.checkins,
               'state',           meganet.base_station_state(b.mode, b.idle_s, b.last_seen_at, v_now),
               'up_s',            case when pg_catalog.jsonb_typeof(b.beat -> 'up') = 'number' then (b.beat -> 'up') end,
               'net',             case when b.net is not null then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                                    'route',  b.net -> 'route',
                                    'family', b.net -> 'family',
                                    'at',     b.net -> 'at',
                                    'v4',     (b.net -> 'v4') - 'key',
                                    'v6',     (b.net -> 'v6') - 'key')) end,
               'events',          coalesce((
                                    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                             'id', l.id, 'kind', l.kind, 'started_at', l.started_at,
                                             'ended_at', l.ended_at, 'seconds', l.seconds,
                                             'from', l.addr_from, 'to', l.addr_to, 'detail', l.detail)
                                           order by l.started_at desc)
                                      from (select * from meganet.base_station_link l
                                             where l.ingest_token_id = t.id
                                               and coalesce(l.ended_at, l.started_at) >= v_from
                                             order by l.started_at desc
                                             limit 2000) l), '[]'::jsonb))
             order by b.last_seen_at desc)
        from meganet.base_station b
        join meganet.ingest_token t on t.id = b.ingest_token_id
       where t.revoked_at is null or b.last_seen_at > v_from), '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station_links(integer) is
  'Every base station''s connection over the last p_days (1–365, default 30) for the Admin tab (0080): its state now, where it last called from (blocks only, never the fingerprint) and its gaps and changes, newest first, at most 2,000 a station. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.base_station_link_note()            from public;
revoke all on function meganet.admin_base_station_links(integer)   from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- authenticated, not anon: admin_require() asks as well, but an anonymous
  -- caller has no business reaching the question.
  grant execute on function meganet.admin_base_station_links(integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('meganet.base_station_link') is null
     or to_regprocedure('meganet.base_station_link_note()') is null
     or to_regprocedure('meganet.admin_base_station_links(integer)') is null
     or not exists (select 1 from pg_catalog.pg_trigger
                     where tgname = 'base_station_link_note' and tgrelid = 'meganet.base_station'::regclass) then
    raise exception '0080 did not take: the connection log table, its trigger or its function is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 80 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '80')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
