-- 0059_health_findings.sql — The network's health, kept by the database: a
-- station silent past its checks, a base station that has stopped checking
-- in, and a receiver that runs but has decoded nothing for hours — each a
-- finding that starts, and clears, with nobody's browser open.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0059_health_findings.sql
--
-- Why this file exists
-- ────────────────────
-- #215, under #214. Until now the network's health was something a person had
-- to go and look at: Station Health works its findings out in the browser
-- from a week of readings when its tab is open, and the Base Stations tab says
-- online / quiet / offline when that tab is open. Nothing noticed anything
-- with both closed, so nothing could tell anybody (#216). And one case nobody
-- caught anywhere: a receiver that is running with its antenna off. The Base
-- Stations tab counts receivers whose state is not `running`; a stick that is
-- running and hears nothing passes that test for ever.
--
-- Four decisions.
--
-- **1. Each rule runs where its one definition lives.** The rules must not
-- become a browser copy and a server copy that drift apart, so none was
-- rewritten for the other side:
--
--   · A station's health — silent past its checks, its battery, a repeater
--     whose stations went quiet together — is health-analysis.js, two
--     thousand lines that learn each station's schedule, attribute shared
--     addresses by where each receiver listens, and set aside corrupted copies
--     and ghosts before judging anything. A SQL port was written and measured
--     against it on the live week: it agreed on most stations and not on the
--     ones where those subtleties decide, so it was dropped rather than kept
--     as a second opinion. The same file runs on a schedule instead —
--     .github/workflows/station-health.yml, Node, every fifteen minutes, as
--     the field photo syncs run — and posts what it finds through
--     report_station_findings() below. The Worker was weighed and set aside:
--     the Workers Free plan this account is on gives a cron invocation 10 ms of
--     CPU, and the analysis of a week takes over a second.
--   · A base station's liveness and its receivers' hearing have no browser
--     copy to keep in step. base_station_state() below is the one definition
--     of online / quiet / offline — the Base Stations tab now shows what the
--     database says rather than working it out again — and only something that
--     watches a receiver's decode count across heartbeats can know it stopped
--     moving. refresh_base_station_findings() does both, in the database, on
--     pg_cron every five minutes, next to the heartbeats it reads.
--
-- **2. A finding starts and clears; it is never re-sent as a state.** One row
-- per finding: `first_seen` when it first held, `last_seen` the last run it
-- still did, `cleared_at` the run it stopped. At most one open row per (source,
-- kind, subject) — a unique index says so — so #216's alerts act on a change
-- (a row that appeared, cleared, or got worse), and every run's answer says
-- which those were. Cleared rows are history, kept 90 days.
--
-- **3. What each side owns.** A row's `source` is the one run that may open,
-- update and clear it: 'stations' (the analysis, through
-- report_station_findings()) or 'base-stations' (refresh_base_station_findings()).
-- Neither touches the other's, and meganet.health_refresh says when each last
-- ran, so a reader can tell fresh findings from a schedule that has stopped.
-- A report that is not complete (the analysis hit its row cap, say) opens and
-- updates but clears nothing; one older than the last accepted is refused.
--
-- **4. Who reads what.** The station analysis works from readings anybody may
-- read (0006, 0050), so its findings are public, like the readings — `anon`
-- selects them, and the agent API's silent-stations endpoint (#230) can serve
-- them. A base station's and its receivers' are about equipment only
-- administrators see (0049): a policy shows those rows to administrators only.
--
-- What a person still does once: apply this (pg_cron is enabled by it where
-- the server has it, as Supabase does), and give the workflow the project's
-- secret key as the repository secret SUPABASE_SECRET_KEY if the field photo
-- syncs have not already (docs/station-health.md).
--
-- Depends on 0002/0004 (station), 0036 (is_admin), 0045/0049 (ingest_token,
-- base_station); redefines 0049's base_station_row() to carry the state and
-- the open findings. On nothing in 0053–0058, so it applies with or without
-- them. tools/check_health_findings.sql proves it.

-- ── The findings ─────────────────────────────────────────────────────────────

create table if not exists meganet.health_finding (
  id               bigint       generated always as identity primary key,
  -- Which run owns it: 'stations' (health-analysis.js, reported) or
  -- 'base-stations' (refresh_base_station_findings()).
  source           text         not null,
  -- A station finding's kind is health-analysis.js's (silent, repeater-down,
  -- battery-low …); a base station's is base-station-quiet or receiver-deaf.
  kind             text         not null,
  -- What it is about, as one key. For a station finding, the analysis' own
  -- finding id (silent:<station id>, rep:<repeater id> …); for a base station,
  -- token:<ingest token id>, and for one of its receivers token:<id>/<key>.
  subject          text         not null,
  station_id       text,
  ingest_token_id  bigint       references meganet.ingest_token (id) on delete cascade,
  rx_key           text,
  severity         text         not null,
  title            text         not null,
  detail           text         not null,
  -- The numbers the words came from.
  evidence         jsonb        not null default '{}'::jsonb,
  first_seen       timestamptz  not null,
  last_seen        timestamptz  not null,
  cleared_at       timestamptz,

  constraint health_finding_source   check (source in ('stations', 'base-stations')),
  constraint health_finding_kind     check (kind ~ '^[a-z][a-z0-9-]{1,39}$'
                                            and (source = 'stations' or kind in ('base-station-quiet', 'receiver-deaf'))),
  constraint health_finding_subject  check (pg_catalog.length(subject) between 1 and 300),
  constraint health_finding_owner    check ((source = 'base-stations') = (ingest_token_id is not null)),
  constraint health_finding_rx       check ((kind = 'receiver-deaf') = (rx_key is not null)),
  constraint health_finding_severity check (severity in ('critical', 'warn', 'info')),
  constraint health_finding_words    check (pg_catalog.length(title) between 1 and 300 and pg_catalog.length(detail) <= 2000),
  constraint health_finding_evidence check (pg_catalog.jsonb_typeof(evidence) = 'object' and pg_catalog.octet_length(evidence::text) <= 8192),
  constraint health_finding_span     check (last_seen >= first_seen and (cleared_at is null or cleared_at >= last_seen))
);

comment on table meganet.health_finding is
  'The network''s health between visits to its tabs (0059): what health-analysis.js finds about stations (source stations, reported every fifteen minutes by .github/workflows/station-health.yml) and what refresh_base_station_findings() finds about base stations and their receivers (source base-stations, every five minutes on pg_cron). One row per finding — first_seen, last_seen, cleared_at — at most one open per (source, kind, subject). Station findings are public; base station findings are administrators only.';
comment on column meganet.health_finding.subject is
  'What it is about, as one key: the analysis'' finding id (silent:<station id>, rep:<repeater id> …), or token:<ingest token id>[/<receiver key>] for a base station.';
comment on column meganet.health_finding.cleared_at is
  'The run it stopped holding — the station heard again, the base station back, the receiver decoding — or what it was about gone (a token revoked, a receiver unplugged and forgotten). Null while open.';

create unique index if not exists health_finding_open
  on meganet.health_finding (source, kind, subject) where cleared_at is null;
create index if not exists health_finding_station_idx
  on meganet.health_finding (station_id, first_seen) where station_id is not null;
create index if not exists health_finding_token_idx
  on meganet.health_finding (ingest_token_id) where ingest_token_id is not null;
create index if not exists health_finding_cleared_idx
  on meganet.health_finding (cleared_at) where cleared_at is not null;

alter table meganet.health_finding enable row level security;
drop policy if exists health_finding_read_public on meganet.health_finding;
create policy health_finding_read_public on meganet.health_finding
  for select to anon, authenticated
  using (ingest_token_id is null);
drop policy if exists health_finding_read_admins on meganet.health_finding;
create policy health_finding_read_admins on meganet.health_finding
  for select to authenticated
  using (meganet.is_admin());

-- ── When each run last happened ──────────────────────────────────────────────

create table if not exists meganet.health_refresh (
  source    text         primary key,
  at        timestamptz  not null,
  took_ms   integer,
  -- What the run said about itself: the window and the readings it read, whether
  -- it was complete, and the commit it ran (station analysis); how much it judged.
  detail    jsonb        not null default '{}'::jsonb,
  constraint health_refresh_source check (source in ('stations', 'base-stations')),
  constraint health_refresh_detail check (pg_catalog.jsonb_typeof(detail) = 'object' and pg_catalog.octet_length(detail::text) <= 4096)
);

comment on table meganet.health_refresh is
  'When each health run last happened and what it read (0059): stations (the analysis, reported) and base-stations (the SQL rules). Public, so a reader can tell fresh findings from a schedule that has stopped.';

alter table meganet.health_refresh enable row level security;
drop policy if exists health_refresh_read on meganet.health_refresh;
create policy health_refresh_read on meganet.health_refresh
  for select to anon, authenticated
  using (true);

-- ── What each receiver last decoded ──────────────────────────────────────────
-- A heartbeat says how many frames each receiver has decoded since its
-- software started (0049; RPi ALERT's beat()), and nothing about when the last
-- one was — an SDR's "seconds since data" is null. This remembers the count
-- and when it last moved, one row per receiver a live base station names; a
-- restart that resets the count is a change like any other.

create table if not exists meganet.health_receiver (
  ingest_token_id  bigint       not null references meganet.ingest_token (id) on delete cascade,
  rx_key           text         not null,
  kind             text,
  name             text,
  state            text,
  decoded          bigint,
  -- When the count last moved — or, the first time a receiver is seen, the
  -- best the heartbeat allows: when it says data last arrived, else then.
  changed_at       timestamptz  not null,
  -- The heartbeat it was last read from.
  seen_at          timestamptz  not null,
  primary key (ingest_token_id, rx_key)
);

comment on table meganet.health_receiver is
  'Each receiver''s decode count at the last heartbeat refresh_base_station_findings() read, and when the count last changed (0059) — what "nothing decoded for 6 hours" is measured from. RLS on, no policy and no grant: administrators see the findings, not this.';

alter table meganet.health_receiver enable row level security;

-- ── A base station's state: one definition ───────────────────────────────────
-- online · quiet · offline · off — what the Base Stations tab shows and what a
-- base-station-quiet finding is opened on, so they cannot disagree. The
-- thresholds are the ones base-stations.js used: online within three of its
-- own check-in intervals and never less than three minutes, quiet within the
-- hour, offline after. Off: the station said it turned check-ins off (0049,
-- decision 3) — a choice, not a fault.

create or replace function meganet.base_station_state(p_mode text, p_idle_s integer, p_last_seen timestamptz, p_now timestamptz)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_mode = 'off' then 'off'
    when p_last_seen is null then 'offline'
    when p_now - p_last_seen <= greatest(interval '180 seconds', coalesce(p_idle_s, 60) * interval '3 seconds') then 'online'
    when p_now - p_last_seen <= interval '1 hour' then 'quiet'
    else 'offline'
  end;
$$;

comment on function meganet.base_station_state(text, integer, timestamptz, timestamptz) is
  'online, quiet, offline or off, from a base station''s mode, check-in interval and last check-in (0059). The one definition: the Base Stations tab shows it and a base-station-quiet finding is opened on it. Internal.';

-- A span as health-analysis.js' fmtSpan() says it — "40 min", "7.5 h",
-- "3.2 days" — so a base station finding reads like a station one.

create or replace function meganet.health_span(p_seconds double precision)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when pg_catalog.round(p_seconds / 60) < 90 then pg_catalog.round(p_seconds / 60)::bigint || ' min'
    when p_seconds / 3600 < 48 then pg_catalog.trim_scale(pg_catalog.round((p_seconds / 3600)::numeric, case when p_seconds / 3600 < 10 then 1 else 0 end)) || ' h'
    else pg_catalog.trim_scale(pg_catalog.round((p_seconds / 86400)::numeric, 1)) || ' days'
  end;
$$;

-- ── The answer every run gives ───────────────────────────────────────────────
-- Brings one source's open findings into line with what the run found
-- (pg_temp._health_now) and says what changed: opened, got worse, cleared.
-- Findings named in pg_temp._health_hold are left as they are — nothing new
-- is known about them. `p_clear` false opens and updates only.

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
  -- Still holding: brought up to date, and noted where it got worse.
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
  'Brings one source''s open health findings into line with pg_temp._health_now and answers what opened, got worse and cleared (0059). Shared by refresh_base_station_findings() and report_station_findings(). Internal.';

-- The two scratch tables a run fills, empty. A second run in one transaction
-- (the checks make several) starts clean.
create or replace function meganet.health_begin()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.to_regclass('pg_temp._health_now') is not null then
    drop table pg_temp._health_now;
  end if;
  if pg_catalog.to_regclass('pg_temp._health_hold') is not null then
    drop table pg_temp._health_hold;
  end if;
  create temporary table _health_now (
    kind text not null, subject text not null, station_id text, ingest_token_id bigint, rx_key text,
    severity text not null, title text not null, detail text not null, evidence jsonb not null,
    primary key (kind, subject)
  ) on commit drop;
  create temporary table _health_hold (kind text, subject text, primary key (kind, subject)) on commit drop;
end;
$$;

comment on function meganet.health_begin() is
  'Creates the scratch tables a health run fills (0059). Internal.';

-- ── Base stations and their receivers ────────────────────────────────────────

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
begin
  -- Once at a time: a run that finds the last one still going leaves it be.
  if not pg_catalog.pg_try_advisory_xact_lock(5900215) then
    return pg_catalog.jsonb_build_object('at', p_now, 'skipped', 'another run is under way');
  end if;
  perform meganet.health_begin();

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
      insert into pg_temp._health_now values (
        'base-station-quiet', 'token:' || b.ingest_token_id, null, b.ingest_token_id, null,
        case v_state when 'offline' then 'critical' else 'warn' end,
        v_label || case v_state when 'offline' then ': offline — not heard from for ' else ': quiet — not heard from for ' end
          || meganet.health_span(v_quiet),
        'It checks in every ' || meganet.health_span(b.idle_s) || ' and has not for ' || meganet.health_span(v_quiet)
          || '. What only its receivers hear is not arriving while it is away: check its power and its network.',
        pg_catalog.jsonb_build_object('state', v_state, 'last_seen_at', b.last_seen_at, 'idle_s', b.idle_s, 'label', v_label));
    end if;

    -- Its receivers are judged on a fresh heartbeat only. Away, nothing new
    -- is known about them: what was found stands, and nothing is added.
    if v_state <> 'online' or b.beat is null or b.beat_at is null then
      insert into pg_temp._health_hold
        select h.kind, h.subject from meganet.health_finding h
         where h.source = 'base-stations' and h.kind = 'receiver-deaf'
           and h.ingest_token_id = b.ingest_token_id and h.cleared_at is null
        on conflict do nothing;
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
        insert into pg_temp._health_now values (
          'receiver-deaf', 'token:' || b.ingest_token_id || '/' || v_rxkey, null, b.ingest_token_id, v_rxkey,
          case when v_quiet >= 86400 then 'critical' else 'warn' end,
          v_label || ' — ' || coalesce(nullif(v_name, ''), v_rxkey) || ': nothing decoded for ' || meganet.health_span(v_quiet),
          case when v_rxstate = 'running'
               then 'It is running, and its count of decoded frames has not moved for ' || meganet.health_span(v_quiet)
                    || '. A disconnected antenna or cable, a channel nobody transmits on, or interference — the station cannot tell which.'
               else 'It is ' || coalesce(v_rxstate, 'in an unknown state') || ', and has decoded nothing for ' || meganet.health_span(v_quiet)
                    || '. Restart it from the Base Stations tab, or check it is plugged in.' end,
          pg_catalog.jsonb_build_object('state', v_rxstate, 'kind', v_kind, 'name', v_name, 'decoded', v_dec,
            'changed_at', v_changed, 'beat_at', b.beat_at, 'limit_h', extract(epoch from v_limit) / 3600, 'label', v_label))
        on conflict do nothing;
      end if;
    end loop;

    -- Receivers it no longer names: unplugged and forgotten, or replaced.
    delete from meganet.health_receiver hr
     where hr.ingest_token_id = b.ingest_token_id and hr.seen_at < b.beat_at;
  end loop;

  -- The memory of receivers whose base station is no longer one.
  delete from meganet.health_receiver hr
   where not exists (select 1 from meganet.base_station bs where bs.ingest_token_id = hr.ingest_token_id);

  v_out := meganet.health_apply('base-stations', p_now, true);
  v_took := greatest(0, extract(epoch from pg_catalog.clock_timestamp() - v_started) * 1000)::integer;

  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('base-stations', p_now, v_took, pg_catalog.jsonb_build_object('base_stations', v_bs, 'receivers', v_rx))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', p_now, 'took_ms', v_took,
           'judged', pg_catalog.jsonb_build_object('base_stations', v_bs, 'receivers', v_rx)) || v_out;
end;
$$;

comment on function meganet.refresh_base_station_findings(timestamptz) is
  'Works out, as of p_now (default now), which base stations have stopped checking in and which receivers have decoded nothing for hours, and brings their health findings up to date (0059): opens, updates, clears, and answers which opened, got worse and cleared — what #216''s alerts act on. pg_cron runs it every five minutes; one at a time. The owner and service_role only.';

-- ── Stations: what the analysis reports ──────────────────────────────────────
-- POST /rest/v1/rpc/report_station_findings with the secret key, body
--   {"p_report": {"at": "<the analysis' now>", "complete": true,
--                 "detail": {"t0", "t1", "readings", "commit", …},
--                 "findings": [{"subject", "kind", "severity", "title", "detail",
--                               "evidence", "station_id"}, …]}}
-- → {"at", "open", "opened", "worse", "cleared"}, or {"stale": true} for a
--   report older than the last one accepted.
--
-- The rules are the analysis' own; this only checks the shape of what it says
-- and keeps the record. tools/health/report.mjs is the one caller.

create or replace function meganet.report_station_findings(p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at       timestamptz;
  v_last     timestamptz;
  v_complete boolean;
  v_detail   jsonb;
  f          jsonb;
  v_i        integer := 0;
  v_out      jsonb;
begin
  if p_report is null or pg_catalog.jsonb_typeof(p_report) <> 'object' then
    raise exception 'report_station_findings takes an object' using errcode = '22023';
  end if;
  begin
    v_at := (p_report ->> 'at')::timestamptz;
  exception when others then
    raise exception 'at is not a time: %', pg_catalog.left(p_report ->> 'at', 40) using errcode = '22023';
  end;
  if v_at is null or v_at > pg_catalog.now() + interval '5 minutes' or v_at < pg_catalog.now() - interval '1 day' then
    raise exception 'at must be within the last day, not %', coalesce(v_at::text, 'missing') using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_report -> 'findings') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_report -> 'findings') > 2000 then
    raise exception 'findings is a list of at most 2,000' using errcode = '22023';
  end if;
  v_complete := coalesce((p_report -> 'complete') = 'true'::jsonb, false);
  v_detail := coalesce(nullif(p_report -> 'detail', 'null'::jsonb), '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_detail) <> 'object' or pg_catalog.octet_length(v_detail::text) > 4096 then
    raise exception 'detail is an object of at most 4 KB' using errcode = '22023';
  end if;

  -- One report at a time, and never an older one over a newer.
  perform pg_catalog.pg_advisory_xact_lock(5900216);
  select hr.at into v_last from meganet.health_refresh hr where hr.source = 'stations';
  if v_last is not null and v_at <= v_last then
    return pg_catalog.jsonb_build_object('stale', true, 'at', v_at, 'last', v_last);
  end if;

  perform meganet.health_begin();
  for f in select * from pg_catalog.jsonb_array_elements(p_report -> 'findings') loop
    v_i := v_i + 1;
    if pg_catalog.jsonb_typeof(f) <> 'object'
       or coalesce(f ->> 'kind', '') !~ '^[a-z][a-z0-9-]{1,39}$'
       or pg_catalog.length(coalesce(f ->> 'subject', '')) not between 1 and 300
       or coalesce(f ->> 'severity', '') not in ('critical', 'warn', 'info')
       or pg_catalog.length(coalesce(f ->> 'title', '')) not between 1 and 300
       or pg_catalog.length(coalesce(f ->> 'detail', '')) > 2000
       or (f ? 'evidence' and f -> 'evidence' <> 'null'::jsonb
           and (pg_catalog.jsonb_typeof(f -> 'evidence') <> 'object' or pg_catalog.octet_length((f -> 'evidence')::text) > 8192))
       or pg_catalog.length(coalesce(f ->> 'station_id', '')) > 200 then
      raise exception 'finding % is not one: it needs a kind, a subject, a severity (critical, warn or info) and a title, and its evidence an object of at most 8 KB', v_i
        using errcode = '22023';
    end if;
    insert into pg_temp._health_now values (
      f ->> 'kind', f ->> 'subject', nullif(f ->> 'station_id', ''), null, null,
      f ->> 'severity', f ->> 'title', coalesce(f ->> 'detail', ''),
      coalesce(nullif(f -> 'evidence', 'null'::jsonb), '{}'::jsonb))
    on conflict (kind, subject) do nothing;
  end loop;

  v_out := meganet.health_apply('stations', v_at, v_complete);

  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('stations', v_at, case when pg_catalog.jsonb_typeof(v_detail -> 'took_ms') = 'number' then (v_detail ->> 'took_ms')::numeric::integer end,
          v_detail || pg_catalog.jsonb_build_object('complete', v_complete, 'findings', v_i))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', v_at, 'complete', v_complete) || v_out;
end;
$$;

comment on function meganet.report_station_findings(jsonb) is
  'What health-analysis.js found about stations, reported by .github/workflows/station-health.yml (0059): opens and updates its findings, clears those it no longer reports when the report is complete, refuses one older than the last accepted, and answers which opened, got worse and cleared. The secret key only.';

-- ── The Base Stations tab: the state, and the open findings ──────────────────
-- 0049's row with two more keys: `state`, from base_station_state() — what
-- the tab shows instead of working it out — and `findings`, what is open
-- about the station and its receivers, worst first.

create or replace function meganet.base_station_row(p_token meganet.ingest_token, p_station meganet.base_station, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id',              p_token.id,
    'label',           p_token.label,
    'host_station_id', p_token.host_station_id,
    'host_station',    (select s.name from meganet.station s where s.id = p_token.host_station_id),
    'created_at',      p_token.created_at,
    'last_used_at',    p_token.last_used_at,
    'revoked_at',      p_token.revoked_at,
    'managed',         p_station.ingest_token_id is not null,
    'app',             p_station.app,
    'version',         p_station.version,
    'mode',            p_station.mode,
    'idle_s',          p_station.idle_s,
    'first_seen_at',   p_station.first_seen_at,
    'last_seen_at',    p_station.last_seen_at,
    'checkins',        p_station.checkins,
    'status',          p_station.status - 'config' - 'access',
    'status_at',       p_station.status_at,
    'access',          case when p_station.status ? 'access' then pg_catalog.jsonb_build_object(
                         'available',    p_station.status -> 'access' -> 'available',
                         'meganet_keys', p_station.status -> 'access' -> 'policy' -> 'meganetKeys',
                         'keys',         pg_catalog.jsonb_array_length(coalesce(p_station.status -> 'access' -> 'keys', '[]'::jsonb)),
                         'ssh',          p_station.status -> 'access' -> 'ssh' -> 'active') end,
    'beat',            p_station.beat,
    'beat_at',         p_station.beat_at,
    'watch_until',     p_station.watch_until,
    'keys_hash',       p_station.keys_hash,
    'waiting',         (select pg_catalog.count(*) from meganet.base_station_command c
                         where c.ingest_token_id = p_token.id and c.status = 'queued' and c.expires_at > p_now),
    'receivers',       coalesce((
                         select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                  'point_id', p.point_id, 'name', p.name, 'receiver', p.receiver, 'last_seen_at', p.last_seen_at)
                                order by p.last_seen_at desc)
                           from meganet.ingest_point_latest p where p.ingest_token_id = p_token.id), '[]'::jsonb),
    'state',           case when p_station.ingest_token_id is null then 'unmanaged'
                            else meganet.base_station_state(p_station.mode, p_station.idle_s, p_station.last_seen_at, p_now) end,
    'findings',        coalesce((
                         select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                  'id', h.id, 'kind', h.kind, 'rx_key', h.rx_key, 'severity', h.severity,
                                  'title', h.title, 'detail', h.detail, 'evidence', h.evidence,
                                  'first_seen', h.first_seen, 'last_seen', h.last_seen)
                                order by case h.severity when 'critical' then 0 when 'warn' then 1 else 2 end, h.first_seen)
                           from meganet.health_finding h
                          where h.ingest_token_id = p_token.id and h.cleared_at is null), '[]'::jsonb));
$$;

comment on function meganet.base_station_row(meganet.ingest_token, meganet.base_station, timestamptz) is
  'One base station as the Base Stations tab lists it (0049), with its state from base_station_state() and its open health findings (0059). Internal.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The runs are the owner's (pg_cron runs as postgres) and the secret key's;
-- the helpers are nobody's. Reading is by table, under the policies.

revoke all on function meganet.base_station_state(text, integer, timestamptz, timestamptz) from public;
revoke all on function meganet.health_span(double precision)                               from public;
revoke all on function meganet.health_apply(text, timestamptz, boolean)                    from public;
revoke all on function meganet.health_begin()                                              from public;
revoke all on function meganet.refresh_base_station_findings(timestamptz)                  from public;
revoke all on function meganet.report_station_findings(jsonb)                              from public;
revoke all on function meganet.base_station_row(meganet.ingest_token, meganet.base_station, timestamptz) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.health_finding to anon, authenticated, service_role;
  grant select on meganet.health_refresh to anon, authenticated, service_role;
  grant execute on function meganet.refresh_base_station_findings(timestamptz) to service_role;
  grant execute on function meganet.report_station_findings(jsonb)             to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── The schedule ─────────────────────────────────────────────────────────────
-- Every five minutes, where the server has pg_cron (Supabase does; CI's
-- postgres:16 does not, and skips this). cron.schedule() replaces a job of
-- the same name, so applying this again changes nothing. Where the extension
-- cannot be loaded it says so and carries on: base station findings are then
-- as fresh as whoever last ran refresh_base_station_findings(), and
-- meganet.health_refresh says how fresh that is.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.refresh_base_station_findings() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-base-station-health', '*/5 * * * *', 'select meganet.refresh_base_station_findings()');
    raise notice 'meganet.refresh_base_station_findings() runs every five minutes (pg_cron job meganet-base-station-health).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): nothing will run meganet.refresh_base_station_findings() on a schedule until it is — Database → Extensions → pg_cron, then apply this file again.', sqlerrm;
  end;
end
$$;

-- The first answer now, rather than in five minutes.
select meganet.refresh_base_station_findings() is not null as first_run;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.health_finding') is null or pg_catalog.to_regclass('meganet.health_receiver') is null
     or pg_catalog.to_regclass('meganet.health_refresh') is null then
    raise exception '0059 did not take: a table is missing';
  end if;
  if not (select pg_catalog.bool_and(c.relrowsecurity) from pg_catalog.pg_class c
           where c.oid in ('meganet.health_finding'::pg_catalog.regclass, 'meganet.health_receiver'::pg_catalog.regclass,
                           'meganet.health_refresh'::pg_catalog.regclass)) then
    raise exception '0059 did not take: RLS is off on one of its tables';
  end if;
  if not exists (select 1 from meganet.health_refresh where source = 'base-stations') then
    raise exception '0059 did not take: the first base station run did not record itself';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if not pg_catalog.has_table_privilege('anon', 'meganet.health_finding', 'select') then
      raise exception '0059 did not take: anon cannot read meganet.health_finding';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.health_finding', 'insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.health_finding', 'insert,update,delete') then
      raise exception '0059 did not take: a browser role can write meganet.health_finding';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.health_receiver', 'select')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.health_receiver', 'select') then
      raise exception '0059 did not take: a browser role can read meganet.health_receiver';
    end if;
    if pg_catalog.has_function_privilege('anon', 'meganet.report_station_findings(jsonb)', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.report_station_findings(jsonb)', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.refresh_base_station_findings(timestamptz)', 'execute') then
      raise exception '0059 did not take: a browser role can run or report the health findings';
    end if;
  end if;
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'meganet-base-station-health') then
      raise warning '0059: pg_cron is installed but the meganet-base-station-health job is not scheduled';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live, as for 0053–0058. The
-- guard means applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '59')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
