-- 0020_mqtt_bureau_number.sql — The <station> topic segment is the bureau
-- station number.
--
-- 0008 defined the MQTT topic scheme's <station> segment as the stations.json
-- slug, on the grounds that a second identifier for one site is a mapping table
-- somebody has to keep in step. The grounds were right; the choice of
-- identifier was wrong, and this migration reverses it.
--
-- The slug is a MegaNet artifact. core.js `slug()` derives it from the station
-- NAME — lowercase, non-alphanumerics to underscore — so `loudoun_br_al` exists
-- because somebody typed "Loudoun Br AL" into this app. It has three problems
-- as the thing burned into logger firmware:
--
--   * Nobody outside MegaNet knows it. A field technician standing at the site
--     has the bureau number on the site card, in the Bureau's systems and on
--     the paperwork. The slug is on none of them.
--   * It moves. Rename the station and the slug the app would now derive no
--     longer matches the one in the firmware — and the firmware is the copy
--     that costs a site visit to change.
--   * It is ours to change. The bureau number is not, which is exactly what
--     makes it a stable key.
--
-- So the identifier a station publishes under is now:
--
--   1. meganet.station.station_number — the bureau/BoM/CBM number, `541155`.
--   2. meganet.station.id, for the things that legitimately have no bureau
--      number: repeaters, radars, base stations, a test rig. 18 of 3,174 rows
--      at the time of writing, and none of them a gauging station.
--
-- This is one identifier per site, not two: a station has a bureau number or it
-- does not, and the rule says which applies. No mapping table appears, because
-- both columns already live on meganet.station and resolution is a lookup, not
-- a translation somebody maintains.
--
-- Measured on the live registry before writing this, and the reason the rule is
-- safe to state so plainly: 3,156 of 3,174 stations carry a number, every one
-- of them distinct; no station id is purely numeric; no station id equals a
-- different station's number; and every id and every number already satisfies
-- the topic-segment grammar in bridge/src/topics.js. The two namespaces are
-- disjoint, so "number first, then id" can never be a coin toss.
--
-- What does NOT change: the reading payload. A reading has always addressed
-- itself with `alert_id`, or `station_number` and `channel` (0006), and
-- `station_number` was always the bureau number. The topic segment says who
-- published; the payload says what was measured and where. Only the first of
-- those was wrong.
--
-- Forward-only, idempotent, no begin/commit — db/README.md holds the rules.

-- ── The number has to be unique before it can be a key ───────────────────────
--
-- station_number has carried a plain btree since 0002 and no uniqueness
-- constraint, and meganet.resolve_station() answers NULL rather than guessing
-- when a number matches two stations. That was a safe silence when the number
-- was one address form among several. As the publisher identity it is not: a
-- duplicate number would make BOTH stations unroutable over MQTT, silently,
-- and the first anyone would know is a gauge that stopped reporting.
--
-- A unique index moves that failure to where it can be fixed — the moment
-- somebody saves the second station, or a registry sync tries to load it —
-- instead of into the telemetry. Live data satisfies it today with zero
-- duplicates; this cannot fail on apply.
create unique index if not exists station_number_unique_idx
  on meganet.station (station_number)
  where station_number <> '' and deleted_at is null;

comment on index meganet.station_number_unique_idx is
  'The bureau number is the MQTT publisher identity (0020), so a duplicate would silently unroute both stations. Fails the write instead. Partial: '''' is "no bureau number", which many stations honestly have, and a soft-deleted station does not hold its number against a live one.';

-- ── Who is publishing under this topic segment? ──────────────────────────────

create or replace function meganet.resolve_publisher(p_segment text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- The bureau number first: that is what the topic scheme names and what the
  -- site card says. Then the station id, for the things with no bureau number.
  -- Each branch yields only a unique answer — resolve_station() already
  -- refuses to guess, and the id is a primary key — so this is a preference
  -- order and never a fallback through an ambiguous match.
  --
  -- `deleted_at is null` and not `enabled`, matching resolve_station() and so
  -- matching the HTTP path: a disabled station that is publishing is a fact
  -- about that station, and recording it against the right one is the point of
  -- 0019. (No station is disabled today, so this changes nothing on apply.)
  select coalesce(
    meganet.resolve_station(null, p_segment),
    (select st.id
       from meganet.station st
      where st.deleted_at is null
        and st.id = nullif(pg_catalog.btrim(coalesce(p_segment, '')), '')));
$$;

comment on function meganet.resolve_publisher(text) is
  'Which station is publishing under this <station> topic segment? The bureau station number first, then the station id for the sites that have no bureau number (repeaters, radars, base stations). Null when the segment names nobody — a station heard before the registry knows it, which 0008 decision 2 keeps as an honest partial identity rather than inventing an id for (0020).';

revoke all on function meganet.resolve_publisher(text) from public;

-- ── The two writers, now resolving by number ─────────────────────────────────
--
-- Both previously resolved with `st.id = v_key`, which is the slug rule this
-- migration reverses. Both now call resolve_publisher(). The KEY they write is
-- unchanged in shape — the resolved station.id when the segment names someone,
-- the raw segment when it does not — so 0019's convergence contract holds
-- exactly as written.

create or replace function meganet.mqtt_status(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text;
  v_online  boolean;
  v_at      timestamptz;
  v_status  jsonb;
  v_bridge  text;
  v_station text;
  v_prev    meganet.station_status%rowtype;
  v_since   timestamptz;
begin
  perform meganet.ingest_token_id();

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'mqtt_status takes an object, got %',
                    coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;

  v_key := nullif(pg_catalog.btrim(coalesce(payload ->> 'station', '')), '');
  if v_key is null then
    raise exception 'mqtt_status needs a station — the <station> segment of the topic'
      using errcode = '22023';
  end if;
  if v_key ~ '[+#/]' then
    raise exception 'station % is a topic, not a topic segment', v_key
      using errcode = '22023';
  end if;

  v_online := coalesce((payload ->> 'online')::boolean, false);
  -- The bridge's clock, not the station's: a status message says the connection
  -- is up now, and "now" is the moment we heard it. A logger with a dead RTC
  -- would otherwise report itself online in 1970.
  v_at     := coalesce(meganet.as_ts(payload -> 'at', 'at'), pg_catalog.now());
  if v_at > pg_catalog.now() + interval '1 day' then
    v_at := pg_catalog.now();
  end if;
  -- The other half of the dead-RTC guard (#102): the comment above always
  -- promised it, and only the future side was written. A logger that boots
  -- with an unset clock says 1970; a retained status can honestly be hours or
  -- even days old, so the floor is generous — anything before 2000 is not a
  -- date, it is an unset clock.
  if v_at < timestamptz '2000-01-01T00:00:00Z' then
    v_at := pg_catalog.now();
  end if;
  v_status := case when pg_catalog.jsonb_typeof(payload -> 'status') = 'object'
                   then payload -> 'status' else '{}'::jsonb end;
  v_bridge := nullif(pg_catalog.btrim(coalesce(payload ->> 'bridge', '')), '');

  -- Resolved, never taken from the payload — same rule as reading.station_id.
  -- The bureau number, then the id: meganet.resolve_publisher (0020).
  v_station := meganet.resolve_publisher(v_key);

  -- Key canonically the moment the identity resolves (0019). Before 0020 the
  -- segment WAS the id, so this assignment was implicit; now the segment is
  -- usually a number and the fold has to be explicit or every station would
  -- key by its number forever.
  v_key := coalesce(v_station, v_key);

  select * into v_prev from meganet.station_status where station_key = v_key;

  -- `since` moves only when the state actually changes, which is the entire
  -- value of the column: "offline since 03:14" survives a bridge that repeats
  -- the retained message on every reconnect.
  v_since := case when v_prev.station_key is null or v_prev.online is distinct from v_online
                  then v_at else v_prev.since end;

  insert into meganet.station_status as ss
    (station_key, station_id, online, since, last_seen_at, last_status,
     reported_by, updated_at)
  values
    (v_key, v_station, v_online, v_since, v_at,
     case when v_status = '{}'::jsonb and v_prev.station_key is not null
          then v_prev.last_status else v_status end,
     v_bridge, pg_catalog.now())
  on conflict (station_key) do update set
    station_id   = coalesce(excluded.station_id, ss.station_id),
    online       = excluded.online,
    since        = excluded.since,
    -- Out-of-order delivery is a fact of a reconnecting client: a retained
    -- message replayed after a live one must not walk the clock backwards.
    last_seen_at = greatest(ss.last_seen_at, excluded.last_seen_at),
    last_status  = case when excluded.last_status = '{}'::jsonb
                        then ss.last_status else excluded.last_status end,
    reported_by  = coalesce(excluded.reported_by, ss.reported_by),
    updated_at   = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'station', v_key, 'station_id', v_station, 'online', v_online, 'since', v_since);
end;
$$;

create or replace function meganet.mqtt_seen(p_station text, p_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text := nullif(pg_catalog.btrim(coalesce(p_station, '')), '');
  v_at      timestamptz := coalesce(p_at, pg_catalog.now());
  v_station text;
begin
  perform meganet.ingest_token_id();

  if v_key is null or v_key ~ '[+#/]' then
    raise exception 'mqtt_seen needs the <station> topic segment' using errcode = '22023';
  end if;
  if v_at > pg_catalog.now() + interval '1 day' then
    v_at := pg_catalog.now();
  end if;

  -- The bureau number, then the id (0020); canonical key once it resolves.
  v_station := meganet.resolve_publisher(v_key);
  v_key     := coalesce(v_station, v_key);

  insert into meganet.station_status as ss
    (station_key, station_id, online, since, last_seen_at, last_reading_at, updated_at)
  values
    (v_key, v_station, true, v_at, v_at, v_at, pg_catalog.now())
  on conflict (station_key) do update set
    last_seen_at    = greatest(ss.last_seen_at, excluded.last_seen_at),
    last_reading_at = greatest(ss.last_reading_at, excluded.last_reading_at),
    station_id      = coalesce(ss.station_id, excluded.station_id),
    updated_at      = pg_catalog.now();
end;
$$;

-- ── The fold has to know about numbers too ───────────────────────────────────
--
-- 0019's convergence re-resolves three key shapes: a row whose station_id is
-- already set, an 'a:<alert address>' form, and an 's:<station number>' form.
-- A bare segment that resolves to nobody is left alone, which was right when
-- the segment was a slug and a slug that named nobody would never name anybody.
--
-- A bureau number is different: a station heard before the registry knows it
-- keys by its number, and the registry sync that adds the station is exactly
-- the event that makes that number resolvable. Without this the row would sit
-- beside the canonical one forever — the twin-row defect 0019 exists to kill,
-- reintroduced through the front door.
--
-- So the candidate's resolution gains a fourth case: any key that is not a live
-- station's id, re-resolved as a publisher segment. That covers a bare number
-- and, unchanged, a bare slug from before this migration.

create or replace function meganet.station_status_converge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_id     text;
  v_target meganet.station_status%rowtype;
  v_online boolean;
  v_since  timestamptz;
  v_win_r  boolean;
  v_folded integer := 0;
begin
  -- Candidates: rows whose key is not a live station's id, re-resolved the
  -- same way the write paths resolve — an 'a:' form by its alert address, an
  -- 's:' form by its station number (meganet.resolve_station, so ambiguity
  -- stays unresolved rather than guessed), a bare topic segment by
  -- meganet.resolve_publisher (0020: bureau number, then id), and a row an
  -- earlier convention resolved under a non-canonical key folds into its own
  -- station_id.
  for r in
    select ss.*,
           coalesce(
             case when ss.station_id is not null and ss.station_id <> ss.station_key
                  then ss.station_id end,
             case when ss.station_key ~ '^a:[0-9]+$'
                  then meganet.resolve_station(substring(ss.station_key from 3)::integer, null) end,
             case when ss.station_key like 's:%'
                  then meganet.resolve_station(null, substring(ss.station_key from 3)) end,
             case when ss.station_key !~ '^[as]:'
                  then meganet.resolve_publisher(ss.station_key) end)
             as resolved
      from meganet.station_status ss
     where not exists (select 1 from meganet.station st
                        where st.id = ss.station_key and st.deleted_at is null)
  loop
    v_id := r.resolved;
    if v_id is null or v_id = r.station_key then
      continue;   -- still honestly unresolved — the row stays as it is
    end if;

    select * into v_target from meganet.station_status where station_key = v_id;

    if v_target.station_key is null then
      -- No canonical row yet: this row simply becomes it.
      update meganet.station_status
         set station_key = v_id, station_id = v_id, updated_at = pg_catalog.now()
       where station_key = r.station_key;
      v_folded := v_folded + 1;
      continue;
    end if;

    -- Merge, with the same out-of-order discipline mqtt_status applies per
    -- row. `online is null` means the row never had an opinion (an HTTP-only
    -- row has no connection to have one about — 0012); an opinionless row
    -- must never overwrite an opinion.
    if r.online is not null and v_target.online is not null then
      -- Both had an opinion: the later word wins the state…
      v_win_r  := coalesce(r.last_seen_at, r.since) > coalesce(v_target.last_seen_at, v_target.since);
      v_online := case when v_win_r then r.online else v_target.online end;
      -- …but an unchanged state keeps the EARLIER honest `since`: if both
      -- rows say offline, the site has been offline since the first of them
      -- said so, not since the newer row happened to repeat it.
      v_since  := case when r.online = v_target.online
                       then least(r.since, v_target.since)
                       when v_win_r then r.since
                       else v_target.since end;
    elsif r.online is not null then
      v_online := r.online;        v_since := r.since;
    elsif v_target.online is not null then
      v_online := v_target.online; v_since := v_target.since;
    else
      v_online := null;            v_since := least(r.since, v_target.since);
    end if;

    update meganet.station_status ss set
      station_id      = v_id,
      online          = v_online,
      since           = v_since,
      last_seen_at    = greatest(ss.last_seen_at, r.last_seen_at),
      last_reading_at = greatest(ss.last_reading_at, r.last_reading_at),
      last_status     = case when ss.last_status = '{}'::jsonb then r.last_status
                             when r.last_status  = '{}'::jsonb then ss.last_status
                             when r.updated_at > ss.updated_at then r.last_status
                             else ss.last_status end,
      reported_by     = coalesce(case when r.updated_at > ss.updated_at
                                      then r.reported_by end,
                                 ss.reported_by, r.reported_by),
      updated_at      = pg_catalog.now()
     where ss.station_key = v_id;

    delete from meganet.station_status where station_key = r.station_key;
    v_folded := v_folded + 1;
  end loop;

  return pg_catalog.jsonb_build_object('folded', v_folded);
end;
$$;

-- ── The convention, restated where readers look ─────────────────────────────

comment on column meganet.station_status.station_key is
  'station.id where the identity resolves (both writers agree on this). Otherwise the identity the transport had: the <station> topic segment from MQTT — the bureau station number, or the id for a site that has none (0020); a:<alert address> or s:<station number> from HTTP ingest. Never contains + # or /. Folded to the id by station_status_converge() once resolution succeeds.';

comment on column meganet.station.station_number is
  'The bureau (BoM/CBM) station number, as text — `541155`, and alphanumeric forms like `422001A` exist. '''' means the site has none, which repeaters, radars and base stations honestly do. Unique among live stations that have one (0020), because it is the MQTT publisher identity: the <station> topic segment of meganet/v1/<station>/… .';

-- ── Who may run it ───────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.resolve_publisher(text) to authenticated, service_role;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 19 → 20 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '20')
on conflict (key) do update set value = excluded.value;
