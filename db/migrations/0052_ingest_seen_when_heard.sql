-- 0052_ingest_seen_when_heard.sql — A station is last seen when it was heard,
-- not when its reading reached the database.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0052_ingest_seen_when_heard.sql
--
-- Why this file exists
-- ────────────────────
-- ingest_http() (0012) unpacks every batch into meganet.station_status, and set
-- last_seen_at to now() for every address in it. Right for a base station
-- posting what it heard a few seconds ago; wrong for one posting what it heard
-- days ago. A base station that was offline over a weekend, or an RPi ALERT
-- site survey sending its readings when it is back on a network, made every
-- station in its backlog look heard at the moment of the upload — including a
-- station that died on Saturday, which station_health then reported as alive.
--
-- now() was deliberate, and for a reason that still holds: last_seen_at counts
-- a reading ingest() refuses, because a logger whose clock has died is still on
-- the air and the fault that needs a person is the clock, not the silence. A
-- dead clock's time says nothing about when the station was heard. So:
--
--   heard at = the reading's own time, no later than now —
--   except   = now, when that time is one ingest() refuses (missing, not a
--              time, before 1990, more than a day ahead), or is more than 90
--              days old in a batch not marked as a backfill: an RTC reset to
--              2000-01-01 is accepted as a reading but is a dead clock all the
--              same, and a live receiver does not hear things a quarter of a
--              year after they were sent. 90 days is meganet.retain()'s default
--              horizon for readings (0006); an older backfill says
--              "source": "backfill", and keeps its own times.
--
-- last_seen_at still only moves forward (greatest), so a backfill can fill a
-- station's history without dragging its last-seen backwards, and a late batch
-- for a station heard since changes nothing. last_reading_at (the readings
-- actually stored) is untouched: it was always their own time.
--
-- What changes
-- ────────────
--   1. meganet.as_ts_or_null(jsonb): as_ts() (0006) that answers null instead
--      of raising — for bookkeeping that must never cost an accepted batch.
--   2. ingest_http() restated from 0012 (the live body checked against the
--      file: the same statements, without the comments), the station_status
--      insert reading each row's time as above. Nothing else in it moves.

-- ── 1. A timestamp, or null ──────────────────────────────────────────────────

create or replace function meganet.as_ts_or_null(p_value jsonb)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  return meganet.as_ts(p_value, 'reading_ts');
exception when others then
  return null;
end;
$$;

comment on function meganet.as_ts_or_null(jsonb) is
  'meganet.as_ts() that answers null instead of raising — ISO 8601, epoch seconds or milliseconds, else null (0052).';

revoke all on function meganet.as_ts_or_null(jsonb) from public;

-- ── 2. ingest_http() ─────────────────────────────────────────────────────────

create or replace function meganet.ingest_http(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_id  bigint;
  v_env       jsonb;
  v_readings  jsonb;
  v_result    jsonb;
  v_raw_id    bigint;
  v_now       timestamptz;
  v_n         integer;
  v_backfill  boolean;
  c_max_batch constant integer := 1000;
begin
  -- The token: 0008's check, PT401 for a missing, unknown or revoked one.
  v_token_id := meganet.ingest_token_id();

  -- A device retrying a timeout deserves a clear refusal, not another timeout.
  v_n := case
           when pg_catalog.jsonb_typeof(payload) = 'array'
             then pg_catalog.jsonb_array_length(payload)
           when pg_catalog.jsonb_typeof(payload) = 'object' and payload ? 'readings'
                and pg_catalog.jsonb_typeof(payload -> 'readings') = 'array'
             then pg_catalog.jsonb_array_length(payload -> 'readings')
           else 1
         end;
  if v_n > c_max_batch then
    raise exception
      'batch of % exceeds the %-reading limit — split it into more than one POST',
      v_n, c_max_batch
      using errcode = '22023';
  end if;

  v_env := case when pg_catalog.jsonb_typeof(payload) = 'object' then payload
                else pg_catalog.jsonb_build_object('readings', payload) end;
  if not v_env ? 'source' then
    v_env := v_env || pg_catalog.jsonb_build_object('source', 'http');
  end if;

  -- Authorises the one ingest() call that follows, and names the ingest point
  -- for the rows it writes; both transaction-local, both after the token check.
  perform pg_catalog.set_config('meganet.ingest_authorized', 'true', true);
  perform pg_catalog.set_config('meganet.ingest_token_id', v_token_id::text, true);

  v_result := meganet.ingest(v_env);

  -- ── Who has been heard from, and when ──────────────────────────────────────
  -- Bookkeeping about readings already stored: a failure here is a warning in
  -- the server log, never an accepted batch lost (a subtransaction; ingest()'s
  -- work survives its rollback).
  begin
    v_now := pg_catalog.now();
    v_backfill := pg_catalog.lower(coalesce(v_env ->> 'source', '')) = 'backfill';

    v_readings := case
      when pg_catalog.jsonb_typeof(v_env -> 'readings') = 'array' then v_env -> 'readings'
      when pg_catalog.jsonb_typeof(v_env) = 'object' then pg_catalog.jsonb_build_array(v_env)
      else '[]'::jsonb end;

    -- Heard from: every address in the batch, whether or not its reading passed
    -- validation, at when it was heard (0052) — its own time, no later than now;
    -- now for a dead clock's time, which says nothing about when.
    insert into meganet.station_status as ss
      (station_key, station_id, last_seen_at, updated_at)
    select k.key, pg_catalog.max(k.sid), pg_catalog.max(k.heard), v_now
      from (
        select coalesce(s.sid,
                        case when s.aid is not null then 'a:' || s.aid
                             else 's:' || s.snum end) as key,
               s.sid,
               case
                 when s.ts is null or s.ts < '1990-01-01'::timestamptz or s.ts > v_now + interval '1 day' then v_now
                 when s.ts < v_now - interval '90 days' and not s.backfill then v_now
                 else least(s.ts, v_now)
               end as heard
          from (
            select meganet.resolve_station(a.aid, a.snum) as sid, a.aid, a.snum, a.ts, a.backfill
              from (
                select case when r ->> 'alert_id' ~ '^[0-9]+$'
                            then (r ->> 'alert_id')::integer end as aid,
                       nullif(pg_catalog.btrim(coalesce(r ->> 'station_number', '')), '') as snum,
                       meganet.as_ts_or_null(r -> 'reading_ts') as ts,
                       case when r ? 'source' then pg_catalog.lower(coalesce(r ->> 'source', '')) = 'backfill'
                            else v_backfill end as backfill
                  from pg_catalog.jsonb_array_elements(v_readings) as r
                 where pg_catalog.jsonb_typeof(r) = 'object'
              ) a
             where a.aid is not null or a.snum is not null
          ) s
      ) k
     -- station_status_key_shape refuses these, and a batch must not die on one.
     where k.key is not null and k.key <> '' and k.key !~ '[+#/]'
     group by k.key
    on conflict (station_key) do update set
      last_seen_at = greatest(ss.last_seen_at, excluded.last_seen_at),
      station_id   = coalesce(ss.station_id, excluded.station_id),
      updated_at   = v_now;

    -- Stored: the rows ingest() actually kept, which it links to its raw row.
    v_raw_id := case when pg_catalog.jsonb_typeof(v_result -> 'raw_id') = 'number'
                     then (v_result ->> 'raw_id')::bigint end;

    if v_raw_id is not null then
      insert into meganet.station_status as ss
        (station_key, station_id, last_reading_at, updated_at)
      select k.key, pg_catalog.max(k.sid), pg_catalog.max(k.ts), v_now
        from (
          select coalesce(r.station_id,
                          case when r.alert_id is not null then 'a:' || r.alert_id
                               else 's:' || coalesce(r.station_number, '') end) as key,
                 r.station_id as sid,
                 r.reading_ts as ts
            from meganet.reading r
           where r.raw_id = v_raw_id
        ) k
       where k.key is not null and k.key <> '' and k.key !~ '[+#/]'
       group by k.key
      on conflict (station_key) do update set
        last_reading_at = greatest(ss.last_reading_at, excluded.last_reading_at),
        station_id      = coalesce(ss.station_id, excluded.station_id),
        updated_at      = v_now;
    end if;
  exception when others then
    -- sqlstate and sqlerrm are plpgsql's own variables: bare, not qualified.
    raise warning 'ingest_http: station_status not updated for token % (%): %',
                  v_token_id, sqlstate, sqlerrm;
  end;

  return v_result;
end;
$$;

comment on function meganet.ingest_http(jsonb) is
  'The HTTP ingest endpoint. Checks X-Ingest-Token, names the ingest point for the transaction, hands the batch to meganet.ingest(), then records which stations were heard from and when — each at its reading''s own time, no later than now, or now for a dead clock''s time (0052). The only door a token opens.';

comment on column meganet.station_status.last_seen_at is
  'When this station was last heard from at all, including through a reading that failed validation — a logger with a dead clock is still transmitting. Through an ingest point, the reading''s own time (no later than the moment it arrived), or that moment for a time a dead clock gave (0052): a batch posted days late fills history without making its stations look heard now. This is the column that answers "has it gone quiet".';

-- create or replace keeps ingest_http()'s grants (0012: anon, authenticated,
-- service_role; nothing for public). The checks say so.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'meganet.ingest_http(jsonb)'::pg_catalog.regprocedure
                    and p.prosrc like '%as_ts_or_null(r -> ''reading_ts'')%') then
    raise exception '0052 did not take: ingest_http() still stamps every station seen now';
  end if;
  if meganet.as_ts_or_null('"not a time"') is not null
     or meganet.as_ts_or_null('1790843886000') <> pg_catalog.to_timestamp(1790843886) then
    raise exception '0052 did not take: as_ts_or_null() misreads a time';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and not pg_catalog.has_function_privilege('anon', 'meganet.ingest_http(jsonb)', 'execute') then
    raise exception '0052 did not take: anon lost ingest_http()';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 51 → 52 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '52')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
