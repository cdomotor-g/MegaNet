-- 0012_base_station_tokens.sql — A token belongs to an ingest point, not to a
-- field station, and a reading remembers which one wrote it.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0012_base_station_tokens.sql
--
-- ── What was actually wrong ──────────────────────────────────────────────────
--
-- Nothing in 0007 refused to work this way. `ingest_http()` never read
-- `station_id`, `alert_low` or `alert_high` — 0007's own decision 3 says so —
-- and `meganet.ingest()` has always resolved every reading in a batch on its own
-- address, so one POST covering forty stations was the shape the endpoint was
-- built for. 0008's bridge is already exactly that: one host, one token, a whole
-- network's readings.
--
-- What was wrong was the vocabulary, and one promise made in it. 0007 said
-- scoping a token to one station was "one `update` away and never a migration".
-- Acted on, that promise pins a base station's token to a single station and
-- breaks the thing it is for. This file retires the promise and reshapes the
-- columns that carried it, so the next person to read the table is not led into
-- writing that update.
--
-- Three decisions, stated here rather than discovered in the SQL.
--
-- **1. `station_id` becomes `host_station_id`, and its meaning inverts.** It was
-- "the station this logger reports for" — a constraint. It is now "the station
-- where this ingest point physically lives" — a location. Renamed rather than
-- recommented, because a column called `station_id` on a token table invites
-- exactly the `where station_id = reading.station_id` check that this migration
-- exists to prevent. `alert_low`/`alert_high` stay, still unenforced, but their
-- comments now say what they are: a single contiguous range, which is not the
-- shape of what a base station hears. Enforcing coverage needs a set of rules
-- and a table of its own, and that is a separate issue, not a smaller one.
--
-- **2. Provenance goes on `meganet.reading`, which is world-readable.** Under
-- per-station tokens "which token wrote this" was answered by the station. Under
-- one token for forty stations it is not answerable at all, and it is the
-- question that makes a shared token safe to operate: what did this token touch,
-- and which ingest point fed us this number. `reading_raw` already carries a
-- loose `submitted_by`, but it ages out on a debugging clock and the question
-- outlives it, so the column goes on `reading` too. The trade that buys: the
-- anon key can see that two readings arrived through the same ingest point. It
-- is a surrogate id and names nothing — the label, the hash and the range live
-- in `meganet.ingest_token`, which has RLS on and no policy for any verb — and
-- this repository already publishes every station, repeater and base in
-- `stations.json`. Network shape was public before this column existed.
--
-- **3. `ingest()` is not touched, and the stamp cannot cost a reading.** The
-- token id travels as a transaction-local GUC set by `ingest_http()` next to the
-- flag it already sets, and the new columns pick it up through a `default`.
-- That keeps 0006's 240-line contract exactly as it is. The per-station
-- last-seen stamping runs after `ingest()` has returned and is wrapped in an
-- exception block: a batch that was accepted must not be lost to a failure in
-- the bookkeeping about it.

-- ── The token is an ingest point ─────────────────────────────────────────────
-- Guarded both ways so a re-run is a no-op, and so a database that already has
-- the new name is left alone rather than erroring.
do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'meganet.ingest_token'::pg_catalog.regclass
                and a.attname = 'station_id' and not a.attisdropped)
     and not exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'meganet.ingest_token'::pg_catalog.regclass
                and a.attname = 'host_station_id' and not a.attisdropped) then
    alter table meganet.ingest_token rename column station_id to host_station_id;
  end if;
end
$$;

comment on table meganet.ingest_token is
  'One row per ingest point — a base station, a satellite or cellular gateway, a serial-connected PC, the MQTT bridge. Not one row per field station: an ingest point writes for every station it can hear. Only token_hash is stored. RLS is on with no policy: reachable only with the service key or a direct connection.';
comment on column meganet.ingest_token.label is
  'Which ingest point this is, in the words someone standing at it would use — "Mt Stuart base", not the name of a station it relays for.';
comment on column meganet.ingest_token.host_station_id is
  'Where this ingest point lives, when it lives at a station MegaNet knows. A location, never a constraint: the readings this token writes are for the stations it hears, which is a different set entirely. Null for a gateway that is not at a station.';
comment on column meganet.ingest_token.alert_low is
  'Optional lower bound of one contiguous ALERT range. Still not enforced. One range is rarely the shape of what a base station hears — real coverage needs a set of rules — so treat this pair as a note, not a scope.';
comment on column meganet.ingest_token.alert_high is
  'Optional upper bound of one contiguous ALERT range. See alert_low: recorded, not enforced, and not the right shape for a base station.';
comment on column meganet.ingest_token.last_used_at is
  'When this ingest point last called. Says the base is alive; says nothing about the stations behind it — one of forty going quiet does not move this column. That question is meganet.station_health.';

-- ── Minting one ──────────────────────────────────────────────────────────────
-- Dropped and recreated rather than replaced: `create or replace function`
-- cannot rename an input parameter, and `p_station_id` is now the wrong word for
-- what the argument means. Same arity and same types, so a positional call site
-- is unaffected; a caller naming `p_station_id :=` gets an error that points at
-- this file, which is better than silently recording a scope that is not one.
drop function if exists meganet.create_ingest_token(text, text, integer, integer);

create or replace function meganet.create_ingest_token(
         p_label           text,
         p_host_station_id text    default null,
         p_alert_low       integer default null,
         p_alert_high      integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_hash  text;
  v_id    bigint;
begin
  if p_label is null or pg_catalog.btrim(p_label) = '' then
    raise exception 'a token needs a label — which base station or gateway is this?'
      using errcode = '23502';
  end if;

  -- Two random UUIDs, hyphens stripped, prefixed so a token is recognisable in a
  -- log line at a glance. gen_random_uuid() has drawn from the OS's CSPRNG since
  -- PostgreSQL 13 — no extension needed.
  v_token := 'mgn_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
                     || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  v_hash  := pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(v_token, 'utf8')), 'hex');

  insert into meganet.ingest_token
    (label, token_hash, host_station_id, alert_low, alert_high, created_by)
  values
    (pg_catalog.btrim(p_label), v_hash, p_host_station_id, p_alert_low, p_alert_high,
     meganet.actor())
  returning id into v_id;

  return pg_catalog.jsonb_build_object(
    'id', v_id, 'label', p_label, 'token', v_token);
end;
$$;

comment on function meganet.create_ingest_token(text, text, integer, integer) is
  'Mint a token for one ingest point — a base station, a gateway, a bridge — and return it once; only its hash is kept. p_host_station_id records where the ingest point lives, not what it may write. See docs/ingest-http.md.';

-- ── Which token is writing, right now ────────────────────────────────────────
-- Reads the transaction-local GUC that ingest_http() sets beside the authorising
-- flag. Used as a column default below, so it has to be total: an unset GUC and
-- a GUC holding anything that is not a plain integer both answer null rather
-- than raising, because a cast error here would fail an insert that is otherwise
-- perfectly good.
create or replace function meganet.current_ingest_token_id()
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select case
           when pg_catalog.current_setting('meganet.ingest_token_id', true) ~ '^[0-9]+$'
             then pg_catalog.current_setting('meganet.ingest_token_id', true)::bigint
         end;
$$;

comment on function meganet.current_ingest_token_id() is
  'The meganet.ingest_token this request proved it holds, or null for a write that came in another way (an editor, the service key, psql). Backs the ingest_token_id default on reading and reading_raw.';

-- ── Provenance ───────────────────────────────────────────────────────────────
-- Nullable and defaulted rather than backfilled: every reading already stored
-- arrived before this column existed, and null is the honest answer for it. Note
-- that adding a nullable column with a non-constant default rewrites the table
-- on PostgreSQL 11+ only if the default is volatile; this one is `stable`, so
-- existing rows keep null and the ALTER is a catalogue change.
alter table meganet.reading
  add column if not exists ingest_token_id bigint;
alter table meganet.reading
  alter column ingest_token_id set default meganet.current_ingest_token_id();

alter table meganet.reading_raw
  add column if not exists ingest_token_id bigint;
alter table meganet.reading_raw
  alter column ingest_token_id set default meganet.current_ingest_token_id();

comment on column meganet.reading.ingest_token_id is
  'Which meganet.ingest_token wrote this reading — the base station or gateway it came in through. Plain bigint and no foreign key, for the same reason raw_id has none: a token row is small and long-lived, but a cascade or a SET NULL would turn readings retention into an index scan per row. Set on insert only, so a duplicate heard again by a second base leaves it alone — dup_paths is where the other paths are recorded.';
comment on column meganet.reading_raw.ingest_token_id is
  'Which meganet.ingest_token submitted this batch. The precise half of submitted_by, which is free text.';

-- Answering "what did this token touch" without scanning the whole table. Small
-- by construction: only the rows an ingest point wrote, which is every row from
-- a device but none from a backfill or a manual edit.
create index if not exists reading_ingest_token_idx on meganet.reading
  (ingest_token_id, received_at) where ingest_token_id is not null;

-- ── station_status stops being an MQTT-only table ────────────────────────────
-- `online` is what a broker said, and an HTTP-fed station has no broker. It was
-- `not null default false`, which would have made every base-station-relayed
-- station read as offline the moment 0012 started stamping rows here. Null now
-- means "nothing has told us whether a connection is up", which is exactly true
-- for a radio station relayed over HTTP — it has no connection to have an
-- opinion about. mqtt_status() coalesces its own value to false before writing,
-- so the MQTT path is unaffected.
alter table meganet.station_status alter column online drop default;
alter table meganet.station_status alter column online drop not null;

comment on table meganet.station_status is
  'What the last thing to speak for each station said about it: an MQTT retained status or LWT from the bridge (0008), or the arrival of a batch through an ingest point (0012). Keyed by the topic segment where MQTT named one and by station id or address otherwise — a station MegaNet has not been told about yet is exactly the one whose silence matters.';
comment on column meganet.station_status.station_key is
  'The identity we had. From MQTT, the <station> topic segment. From HTTP ingest, the resolved station id, or a:<alert address> / s:<station number> where the address resolves to no one station. Never contains + # or /.';
comment on column meganet.station_status.online is
  'What the broker last told us, and null when nothing ever has — a station relayed over radio and posted by HTTP has no connection to be up or down. Not a health verdict either way: a logger that publishes hourly is offline between transmissions and perfectly well. See meganet.station_health.';
comment on column meganet.station_status.last_seen_at is
  'When this station was last heard from at all, including through a reading that failed validation — a logger with a dead clock is still transmitting. This is the column that answers "has it gone quiet".';
comment on column meganet.station_status.last_reading_at is
  'When a reading from this station was last actually stored. Lags last_seen_at exactly when something is arriving and being rejected.';

-- ── The endpoint ─────────────────────────────────────────────────────────────
-- Same door, same header, same answers. Three changes: the token check is now
-- 0008's meganet.ingest_token_id() rather than a second copy of it inline, the
-- token's id is published to the transaction so the columns above can default
-- from it, and what the batch says about who is alive is recorded once ingest()
-- has returned.
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
  c_max_batch constant integer := 1000;
begin
  -- Checks X-Ingest-Token against meganet.ingest_token, stamps last_used_at, and
  -- raises PT401 — PostgREST's custom-status convention — for a missing, unknown
  -- or revoked token. 0007 did this inline; 0008 factored it out for its own
  -- endpoints and this is the last caller to stop carrying its own copy.
  v_token_id := meganet.ingest_token_id();

  -- Batch limit. ingest() would work through an oversized array just fine, but a
  -- device retrying a timeout deserves a clear refusal rather than a request that
  -- times out again the same way.
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

  -- Default the envelope's source to http, the same way any other adapter would
  -- identify itself; a caller with a better answer (a backfill riding this same
  -- door with its own token) may still say so.
  v_env := case when pg_catalog.jsonb_typeof(payload) = 'object' then payload
                else pg_catalog.jsonb_build_object('readings', payload) end;
  if not v_env ? 'source' then
    v_env := v_env || pg_catalog.jsonb_build_object('source', 'http');
  end if;

  -- Two transaction-local settings, both set here and nowhere else, both after
  -- the token check above has passed. The first authorises the single ingest()
  -- call that follows — meganet.is_editor() reads it and nothing else does. The
  -- second names the ingest point, for the ingest_token_id defaults on reading
  -- and reading_raw. Neither can outlive this call, because PostgREST runs every
  -- request in its own transaction. The second is a record and not a permission:
  -- anything able to forge it could forge the first, and the first is the one
  -- that decides whether a write happens at all.
  perform pg_catalog.set_config('meganet.ingest_authorized', 'true', true);
  perform pg_catalog.set_config('meganet.ingest_token_id', v_token_id::text, true);

  v_result := meganet.ingest(v_env);

  -- ── Who has been heard from ────────────────────────────────────────────────
  -- One base station's POST is the only evidence that forty field stations are
  -- still transmitting; ingest_token.last_used_at cannot carry that, because it
  -- moves for the base whether one station has gone quiet or none has. So the
  -- batch is unpacked into meganet.station_status, the same place the MQTT
  -- bridge reports to, and meganet.station_health answers the question for both.
  --
  -- Wrapped, because this is bookkeeping about readings that are already stored.
  -- A malformed address that resolve_station() copes with but this block does
  -- not must cost a warning in the server log, never an accepted batch. The
  -- exception block is a subtransaction and ingest() ran before it, so its work
  -- survives a rollback in here.
  begin
    v_now := pg_catalog.now();

    v_readings := case
      when pg_catalog.jsonb_typeof(v_env -> 'readings') = 'array' then v_env -> 'readings'
      when pg_catalog.jsonb_typeof(v_env) = 'object' then pg_catalog.jsonb_build_array(v_env)
      else '[]'::jsonb end;

    -- Heard from: every address in the batch, whether or not its reading passed
    -- validation. A station whose RTC has died is still on the air, and the
    -- fault that needs a person is the clock, not the silence.
    insert into meganet.station_status as ss
      (station_key, station_id, last_seen_at, updated_at)
    select k.key, pg_catalog.max(k.sid), v_now, v_now
      from (
        select coalesce(s.sid,
                        case when s.aid is not null then 'a:' || s.aid
                             else 's:' || s.snum end) as key,
               s.sid
          from (
            select meganet.resolve_station(a.aid, a.snum) as sid, a.aid, a.snum
              from (
                select case when r ->> 'alert_id' ~ '^[0-9]+$'
                            then (r ->> 'alert_id')::integer end as aid,
                       nullif(pg_catalog.btrim(coalesce(r ->> 'station_number', '')), '') as snum
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
    -- Null when the caller passed "keep_raw": false, in which case last_seen_at
    -- above is the whole answer and last_reading_at simply does not move.
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
    -- `sqlstate` and `sqlerrm` are plpgsql's own variables, not functions, so
    -- they are bare here where everything else in this file is schema-qualified
    -- against `search_path = ''`. Qualifying them raises inside the handler,
    -- which loses the batch this block exists to protect.
    raise warning 'ingest_http: station_status not updated for token % (%): %',
                  v_token_id, sqlstate, sqlerrm;
  end;

  return v_result;
end;
$$;

comment on function meganet.ingest_http(jsonb) is
  'The HTTP ingest endpoint. Checks X-Ingest-Token, names the ingest point for the transaction, hands the batch to meganet.ingest(), then records what the batch says about which stations are still transmitting. The only door a token opens.';

-- ── Who may run what ─────────────────────────────────────────────────────────
-- Same rule as every migration before this one: EXECUTE defaults to PUBLIC on a
-- new function, so it is revoked and re-granted by name. create_ingest_token()
-- was dropped above, which took its grants with it.
revoke all on function meganet.create_ingest_token(text, text, integer, integer) from public;
revoke all on function meganet.current_ingest_token_id()                         from public;
revoke all on function meganet.ingest_http(jsonb)                                from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant execute on function meganet.create_ingest_token(text, text, integer, integer)
    to service_role;
  grant execute on function meganet.ingest_http(jsonb)
    to anon, authenticated, service_role;
  -- Granted widely because it is a column default and reveals nothing: it reads
  -- one transaction-local setting belonging to the caller's own request.
  grant execute on function meganet.current_ingest_token_id()
    to anon, authenticated, service_role;

  -- The grants on reading and reading_raw are per table, not per column, so
  -- ingest_token_id inherits them — but PostgREST caches the column list, and a
  -- cache that predates this file would refuse it as an unknown one.
  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '12')
on conflict (key) do update set value = excluded.value;
