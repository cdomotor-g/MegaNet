-- 0017_ingest_hardening.sql — Two repairs out of the #102 ingest audit.
--
-- 1. An index on meganet.reading.raw_id. The deployed ingest_http() (0012)
--    looks readings up by raw_id on every successful POST that keeps its raw
--    frame — and no migration ever indexed the column, so that bookkeeping was
--    a sequential scan of the readings table, growing with every reading it
--    was scanning for.
--
-- 2. meganet.mqtt_status() gains the past half of its dead-RTC guard. Its own
--    comment has always said "a logger with a dead RTC would otherwise report
--    itself online in 1970" — and only the future side was clamped, so an
--    `at` of 1970 went straight into station_status.since. Restated in full
--    (the only way to change a plpgsql function), with the one addition
--    marked; tools/check_mqtt.sql's 39 checks are the net that proves the
--    restatement dropped nothing.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0017_ingest_hardening.sql

-- ── The index ────────────────────────────────────────────────────────────────

create index if not exists reading_raw_id_idx
  on meganet.reading (raw_id)
  where raw_id is not null;

comment on index meganet.reading_raw_id_idx is
  'ingest_http() (0012) counts a POST''s stored readings back off reading.raw_id; without this, that is a sequential scan per POST (#102).';

-- ── mqtt_status, restated with the past clamp ───────────────────────────────

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
  select st.id into v_station from meganet.station st
   where st.id = v_key and st.enabled;

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

notify pgrst, 'reload schema';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $do$
begin
  if not exists (select 1 from pg_catalog.pg_indexes
                  where schemaname = 'meganet' and indexname = 'reading_raw_id_idx') then
    raise exception '0017 did not take: reading_raw_id_idx is missing';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.mqtt_status(jsonb)'::regprocedure)
     not like '%2000-01-01%' then
    raise exception '0017 did not take: mqtt_status has no past clamp';
  end if;
end
$do$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 16 → 17 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '17')
on conflict (key) do update set value = excluded.value;
