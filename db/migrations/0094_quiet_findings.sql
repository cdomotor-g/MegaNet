-- 0094_quiet_findings.sql — The health findings written only when something
-- is new: an unchanged open finding left alone for up to an hour, and the
-- five-minute base-station check making no temporary tables when it has
-- nothing to report.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0094_quiet_findings.sql
--
-- Why this file exists
-- ────────────────────
-- The last of the writers 0087 and 0089 left (Supabase's Disk IO Budget
-- warning, 2026-10-28), each about 21 MB of WAL a day:
--
-- **1. health_apply(), every run of every source.** It rewrote every open
-- finding on every run — severity, title, detail, evidence and last_seen —
-- whether or not any of it had changed: 86 station findings every fifteen
-- minutes, about 360 KB of WAL a run. Now a finding is rewritten when what
-- is said about it changes, or when its last_seen is 45 minutes old. So
-- last_seen is right to within the hour, which the owner accepted
-- (2026-10-31); nothing decides anything by it, and a finding clears at the
-- run that no longer finds it, as before. What opened, got worse and
-- cleared is answered exactly as before: a worse finding has a new severity,
-- so it is always rewritten.
--
-- **2. refresh_base_station_findings(), every five minutes.** Each run made
-- health_apply()'s two temporary tables and dropped them again: a dozen
-- system-catalog rows in and out, 42–57 KB of WAL to write three small
-- rows. Most runs find nothing (two base stations online, no open
-- findings). Now a run collects what it finds first, and only makes the
-- tables and calls health_apply() when it found something or something is
-- open; otherwise it does health_apply()'s housekeeping (findings cleared
-- 90 days ago go) and answers the same empty lists. It still runs every
-- five minutes, so an offline base station is found as soon as before.
--
-- Who may run each is unchanged: create or replace keeps their grants.

-- ── 1. health_apply(): the findings nothing new is known about ───────────────

create or replace function meganet.health_apply(p_source text, p_now timestamptz, p_clear boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worse    jsonb;
  v_opened   jsonb;
  v_cleared  jsonb := '[]'::jsonb;
  v_open     integer;
begin
  -- Still holding: brought up to date, and noted where it got worse. A
  -- finding nothing new is known about is left as it is until its last_seen
  -- is 45 minutes old, so last_seen is right to within the hour; rewriting
  -- every open finding on every run was most of what a run wrote (0094).
  with cur as (
    select h.id as fid, h.severity as was, n.*
      from pg_temp._health_now n
      join meganet.health_finding h
        on h.source = p_source and h.kind = n.kind and h.subject = n.subject and h.cleared_at is null
  ), upd as (
    update meganet.health_finding h
       set severity = cur.severity, title = cur.title, detail = cur.detail, evidence = cur.evidence,
           station_id = cur.station_id, last_seen = greatest(p_now, h.last_seen)
      from cur
     where h.id = cur.fid
       and (h.severity is distinct from cur.severity or h.title is distinct from cur.title
            or h.detail is distinct from cur.detail or h.evidence is distinct from cur.evidence
            or h.station_id is distinct from cur.station_id
            or h.last_seen <= p_now - interval '45 minutes')
    returning h.id, h.kind, h.subject, h.station_id, h.severity, h.title, cur.was
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', u.id, 'kind', u.kind, 'subject', u.subject,
                    'station_id', u.station_id, 'severity', u.severity, 'was', u.was, 'title', u.title) order by u.id), '[]'::jsonb)
    into v_worse
    from upd u
   where (u.severity = 'critical' and u.was <> 'critical') or (u.severity = 'warn' and u.was = 'info');

  -- New.
  with ins as (
    insert into meganet.health_finding (source, kind, subject, station_id, ingest_token_id, rx_key,
                                        severity, title, detail, evidence, first_seen, last_seen)
    select p_source, n.kind, n.subject, n.station_id, n.ingest_token_id, n.rx_key,
           n.severity, n.title, n.detail, n.evidence, p_now, p_now
      from pg_temp._health_now n
     where not exists (select 1 from meganet.health_finding h
                        where h.source = p_source and h.kind = n.kind and h.subject = n.subject and h.cleared_at is null)
    returning id, kind, subject, station_id, severity, title
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', i.id, 'kind', i.kind, 'subject', i.subject,
                    'station_id', i.station_id, 'severity', i.severity, 'title', i.title) order by i.id), '[]'::jsonb)
    into v_opened from ins i;

  -- No longer holding, unless held for want of news.
  if p_clear then
    with clr as (
      update meganet.health_finding h
         set cleared_at = greatest(p_now, h.last_seen)
       where h.source = p_source and h.cleared_at is null
         and not exists (select 1 from pg_temp._health_now n where n.kind = h.kind and n.subject = h.subject)
         and not exists (select 1 from pg_temp._health_hold d where d.kind = h.kind and d.subject = h.subject)
      returning h.id, h.kind, h.subject, h.station_id, h.severity, h.title
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'kind', c.kind, 'subject', c.subject,
                      'station_id', c.station_id, 'severity', c.severity, 'title', c.title) order by c.id), '[]'::jsonb)
      into v_cleared from clr c;
  end if;

  -- History is kept for a quarter of a year.
  delete from meganet.health_finding h where h.source = p_source and h.cleared_at < p_now - interval '90 days';

  select pg_catalog.count(*)::integer into v_open
    from meganet.health_finding h where h.source = p_source and h.cleared_at is null;

  return pg_catalog.jsonb_build_object('open', v_open, 'opened', v_opened, 'worse', v_worse, 'cleared', v_cleared);
end;
$$;

comment on function meganet.health_apply(text, timestamptz, boolean) is
  'Brings one source''s open health findings into line with pg_temp._health_now and answers what opened, got worse and cleared (0059). A finding that has not changed is rewritten only once its last_seen is 45 minutes old, so last_seen is right to within the hour (0094). Shared by refresh_base_station_findings(), report_station_findings() and refresh_transmitter_findings(). Internal.';

-- ── 2. refresh_base_station_findings(): the usual run writes almost nothing ─

create or replace function meganet.refresh_base_station_findings(p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started  timestamptz := pg_catalog.clock_timestamp();
  b          record;
  r          jsonb;
  v_state    text;
  v_label    text;
  v_rxkey    text;
  v_rxstate  text;
  v_dec      bigint;
  v_ago      double precision;
  v_kind     text;
  v_name     text;
  v_mem      meganet.health_receiver;
  v_changed  timestamptz;
  v_limit    interval;
  v_quiet    double precision;
  v_bs       integer := 0;
  v_rx       integer := 0;
  v_out      jsonb;
  v_took     integer;
  v_now      jsonb := '[]'::jsonb;   -- what this run finds, in the order found (0094)
  v_hold     bigint[] := '{}';       -- base stations away: their receivers' findings stand (0094)
begin
  -- Once at a time: a run that finds the last one still going leaves it be.
  if not pg_catalog.pg_try_advisory_xact_lock(5900215) then
    return pg_catalog.jsonb_build_object('at', p_now, 'skipped', 'another run is under way');
  end if;

  for b in
    select bs.*, t.label, t.revoked_at
      from meganet.base_station bs
      join meganet.ingest_token t on t.id = bs.ingest_token_id
     order by bs.ingest_token_id
  loop
    -- A revoked token, or a station that turned check-ins off: nothing to
    -- find, and nothing to remember.
    if b.revoked_at is not null or b.mode = 'off' then
      delete from meganet.health_receiver hr where hr.ingest_token_id = b.ingest_token_id;
      continue;
    end if;
    v_bs := v_bs + 1;
    v_label := coalesce(nullif(pg_catalog.btrim(b.label), ''), 'Ingest point ' || b.ingest_token_id);
    v_state := meganet.base_station_state(b.mode, b.idle_s, b.last_seen_at, p_now);
    v_quiet := extract(epoch from p_now - b.last_seen_at);

    if v_state in ('quiet', 'offline') then
      v_now := v_now || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'base-station-quiet', 'subject', 'token:' || b.ingest_token_id, 'station_id', null,
        'ingest_token_id', b.ingest_token_id, 'rx_key', null,
        'severity', case v_state when 'offline' then 'critical' else 'warn' end,
        'title', v_label || case v_state when 'offline' then ': offline — not heard from for ' else ': quiet — not heard from for ' end
          || meganet.health_span(v_quiet),
        'detail', 'It checks in every ' || meganet.health_span(b.idle_s) || ' and has not for ' || meganet.health_span(v_quiet)
          || '. What only its receivers hear is not arriving while it is away: check its power and its network.',
        'evidence', pg_catalog.jsonb_build_object('state', v_state, 'last_seen_at', b.last_seen_at, 'idle_s', b.idle_s, 'label', v_label)));
    end if;

    -- Its receivers are judged on a fresh heartbeat only. Away, nothing new
    -- is known about them: what was found stands, and nothing is added.
    if v_state <> 'online' or b.beat is null or b.beat_at is null then
      v_hold := v_hold || b.ingest_token_id;
      continue;
    end if;

    -- Each receiver in the heartbeat: [key, state, decoded, seconds since data].
    for r in select * from pg_catalog.jsonb_array_elements(coalesce(b.beat -> 'rx', '[]'::jsonb)) loop
      continue when pg_catalog.jsonb_typeof(r) <> 'array' or pg_catalog.jsonb_typeof(r -> 0) <> 'string';
      v_rxkey   := pg_catalog.left(r ->> 0, 80);
      v_rxstate := r ->> 1;
      v_dec     := case when pg_catalog.jsonb_typeof(r -> 2) = 'number' then (r ->> 2)::numeric::bigint end;
      v_ago     := case when pg_catalog.jsonb_typeof(r -> 3) = 'number' then (r ->> 3)::double precision end;
      v_kind := null; v_name := null;
      select x ->> 'kind', x ->> 'name' into v_kind, v_name
        from pg_catalog.jsonb_array_elements(coalesce(b.status -> 'receivers', '[]'::jsonb)) x
       where pg_catalog.right(x ->> 'key', 80) = v_rxkey
       limit 1;
      -- A GPS hears no stations; a receiver set aside on the station was set
      -- aside on purpose.
      continue when v_kind = 'gps' or v_rxstate in ('disabled', 'ignore', 'ignored');
      v_rx := v_rx + 1;

      select * into v_mem from meganet.health_receiver hr
       where hr.ingest_token_id = b.ingest_token_id and hr.rx_key = v_rxkey;
      if not found then
        v_changed := least(b.beat_at, b.beat_at - coalesce(v_ago, 0) * interval '1 second');
      elsif v_mem.decoded is distinct from v_dec then
        v_changed := b.beat_at;
      else
        v_changed := v_mem.changed_at;
      end if;
      insert into meganet.health_receiver as hr (ingest_token_id, rx_key, kind, name, state, decoded, changed_at, seen_at)
      values (b.ingest_token_id, v_rxkey, v_kind, v_name, v_rxstate, v_dec, v_changed, b.beat_at)
      on conflict (ingest_token_id, rx_key) do update set
        kind = excluded.kind, name = excluded.name, state = excluded.state, decoded = excluded.decoded,
        changed_at = excluded.changed_at, seen_at = excluded.seen_at;

      -- A busy channel decodes something every few minutes, so six hours of
      -- nothing on an SDR or an ERT-A2 is an antenna, a cable or a channel; a
      -- radio on a quieter one gets twelve. A day is critical.
      v_limit := case when v_kind in ('sdr', 'ert-a2') then interval '6 hours' else interval '12 hours' end;
      v_quiet := extract(epoch from p_now - v_changed);
      if p_now - v_changed >= v_limit then
        v_now := v_now || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind', 'receiver-deaf', 'subject', 'token:' || b.ingest_token_id || '/' || v_rxkey, 'station_id', null,
          'ingest_token_id', b.ingest_token_id, 'rx_key', v_rxkey,
          'severity', case when v_quiet >= 86400 then 'critical' else 'warn' end,
          'title', v_label || ' — ' || coalesce(nullif(v_name, ''), v_rxkey) || ': nothing decoded for ' || meganet.health_span(v_quiet),
          'detail', case when v_rxstate = 'running'
               then 'It is running, and its count of decoded frames has not moved for ' || meganet.health_span(v_quiet)
                    || '. A disconnected antenna or cable, a channel nobody transmits on, or interference — the station cannot tell which.'
               else 'It is ' || coalesce(v_rxstate, 'in an unknown state') || ', and has decoded nothing for ' || meganet.health_span(v_quiet)
                    || '. Restart it from the Base Stations tab, or check it is plugged in.' end,
          'evidence', pg_catalog.jsonb_build_object('state', v_rxstate, 'kind', v_kind, 'name', v_name, 'decoded', v_dec,
            'changed_at', v_changed, 'beat_at', b.beat_at, 'limit_h', extract(epoch from v_limit) / 3600, 'label', v_label)));
      end if;
    end loop;

    -- Receivers it no longer names: unplugged and forgotten, or replaced.
    delete from meganet.health_receiver hr
     where hr.ingest_token_id = b.ingest_token_id and hr.seen_at < b.beat_at;
  end loop;

  -- The memory of receivers whose base station is no longer one.
  delete from meganet.health_receiver hr
   where not exists (select 1 from meganet.base_station bs where bs.ingest_token_id = hr.ingest_token_id);

  -- Found nothing, and nothing open to update or clear: the usual run. Then
  -- health_apply() has nothing to do, and the two temporary tables it reads
  -- are not made — creating and dropping them was most of what a run wrote
  -- to the log, every five minutes (0094). Its housekeeping still happens.
  if pg_catalog.jsonb_array_length(v_now) > 0
     or exists (select 1 from meganet.health_finding h where h.source = 'base-stations' and h.cleared_at is null) then
    perform meganet.health_begin();
    -- In the order found: a receiver named twice in a heartbeat keeps the
    -- first, as the insert ... on conflict do nothing in the loop did.
    insert into pg_temp._health_now (kind, subject, station_id, ingest_token_id, rx_key, severity, title, detail, evidence)
    select x.kind, x.subject, x.station_id, x.ingest_token_id, x.rx_key, x.severity, x.title, x.detail, x.evidence
      from pg_catalog.jsonb_array_elements(v_now) with ordinality e(j, i)
      cross join lateral pg_catalog.jsonb_to_record(e.j) as x(kind text, subject text, station_id text, ingest_token_id bigint,
                                                               rx_key text, severity text, title text, detail text, evidence jsonb)
     order by e.i
    on conflict do nothing;
    insert into pg_temp._health_hold
      select h.kind, h.subject from meganet.health_finding h
       where h.source = 'base-stations' and h.kind = 'receiver-deaf'
         and h.ingest_token_id = any (v_hold) and h.cleared_at is null
      on conflict do nothing;
    v_out := meganet.health_apply('base-stations', p_now, true);
  else
    delete from meganet.health_finding h where h.source = 'base-stations' and h.cleared_at < p_now - interval '90 days';
    v_out := pg_catalog.jsonb_build_object('open', 0, 'opened', '[]'::jsonb, 'worse', '[]'::jsonb, 'cleared', '[]'::jsonb);
  end if;
  v_took := greatest(0, extract(epoch from pg_catalog.clock_timestamp() - v_started) * 1000)::integer;

  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('base-stations', p_now, v_took, pg_catalog.jsonb_build_object('base_stations', v_bs, 'receivers', v_rx))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', p_now, 'took_ms', v_took,
           'judged', pg_catalog.jsonb_build_object('base_stations', v_bs, 'receivers', v_rx)) || v_out;
end;
$$;

comment on function meganet.refresh_base_station_findings(timestamptz) is
  'Works out, as of p_now (default now), which base stations have stopped checking in and which receivers have decoded nothing for hours, and brings their health findings up to date (0059): opens, updates, clears, and answers which opened, got worse and cleared — what #216''s alerts act on. A run that finds nothing, with nothing open, makes no temporary tables (0094). pg_cron runs it every five minutes; one at a time. The owner and service_role only.';

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.health_apply(text,timestamptz,boolean)'::regprocedure),
                       'h.last_seen <= p_now - interval ''45 minutes''') = 0 then
    raise exception '0094 did not take: health_apply() still rewrites every open finding';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.refresh_base_station_findings(timestamptz)'::regprocedure),
                       'v_now := v_now ||') = 0 then
    raise exception '0094 did not take: refresh_base_station_findings() still makes its tables every run';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live.

insert into meganet.app_meta (key, value)
values ('schema_version', '94')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
