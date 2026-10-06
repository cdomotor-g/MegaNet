-- 0053_station_and_token_request_guards.sql — Validate editor-set station
-- fields on write, and stop withdrawn token requests from accumulating.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0053_station_and_token_request_guards.sql
--
-- Why this file exists
-- ────────────────────
-- Two findings from the 2026-10 security appraisal, each fixed at the source in
-- the database so no write path can reintroduce it:
--
--  1. (H-1) save_station (0044) stored station.roles[] and
--     station.radio_network_ids[] verbatim, with no value check. The web app
--     renders both — the station table, the station card, and the map popup
--     that every visitor sees — so a value carrying markup was stored XSS. The
--     escaping fix at the sinks is matched here by refusing bad values on the
--     way in: a role must be one the app itself offers (core.js ROLE_LABEL),
--     and every radio_network_ids entry must name a real meganet.radio_network
--     (netName() falls back to the raw id otherwise, which is how an id becomes
--     on-screen text). A trigger enforces it on INSERT and UPDATE, so
--     save_station, load_stations_doc and any direct write are all covered.
--     Existing rows are not revalidated — the trigger fires on write only — and
--     the live data already satisfies both rules.
--
--  2. (H-3) withdraw_ingest_token_request (0048) only marked a pending request
--     'withdrawn', and a withdrawn row lingered 30 days. An anonymous caller
--     could request-then-withdraw in a loop and grow the table without bound —
--     enough to fill the free tier and stop ingest. Withdrawing now deletes the
--     pending request outright, so the loop leaves nothing behind; the
--     20-pending cap in request_ingest_token still bounds requests left open.
--     Rows the old behaviour already left are cleaned up once, here.
--
-- Deliberately NOT in this file, because each needs a decision or sizing
-- against live data rather than a safe default (tracked separately):
--   • the ingest-token "kind" gate on mqtt_status / mqtt_seen / bridge_heartbeat
--     and per-token address scoping (appraisal H-2);
--   • octet_length caps on reading_raw / reading / station_status (M-6).

-- ── 1. Station write validation (H-1) ────────────────────────────────────────

create or replace function meganet.station_write_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bad text;
begin
  -- roles: only the vocabulary the editor itself offers (core.js ROLE_LABEL).
  -- A value outside it is a typo or markup smuggled in for the table/popup.
  select r into v_bad
    from pg_catalog.unnest(coalesce(new.roles, array[]::text[])) as r
   where r <> all (array['field', 'repeater', 'base', 'satcom'])
   limit 1;
  if v_bad is not null then
    raise exception 'station.roles has an unknown role: %', v_bad
      using errcode = '23514',
            hint = 'roles are field, repeater, base or satcom';
  end if;

  -- radio_network_ids: every entry must name a network that exists.
  select nid into v_bad
    from pg_catalog.unnest(coalesce(new.radio_network_ids, array[]::text[])) as nid
   where not exists (select 1 from meganet.radio_network rn where rn.id = nid)
   limit 1;
  if v_bad is not null then
    raise exception 'station.radio_network_ids names a network that does not exist: %', v_bad
      using errcode = '23503',
            hint = 'add the network to meganet.radio_network first, or correct the id';
  end if;

  return new;
end;
$$;

comment on function meganet.station_write_guard() is
  'BEFORE INSERT/UPDATE on meganet.station: roles must be from the app vocabulary (field/repeater/base/satcom) and every radio_network_ids entry must exist. Closes the stored-XSS source left by 0044 (security appraisal H-1).';

drop trigger if exists station_write_guard on meganet.station;
create trigger station_write_guard
  before insert or update on meganet.station
  for each row execute function meganet.station_write_guard();

-- ── 2. Token-request withdrawal deletes rather than lingers (H-3) ─────────────

create or replace function meganet.withdraw_ingest_token_request(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := meganet.ingest_token_request_hash();
begin
  if v_hash is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'send the token the request was made with';
  end if;
  -- Delete, don't mark: a 'withdrawn' row used to linger 30 days, so
  -- request-then-withdraw in a loop grew the table without bound (appraisal
  -- H-3). Scoped to the caller's own token hash, and only while still pending.
  delete from meganet.ingest_token_request
   where token_hash = v_hash and status = 'pending';
  -- The request is gone; say so plainly rather than returning 'unknown'.
  return pg_catalog.jsonb_build_object('status', 'withdrawn');
end;
$$;

-- Clean up rows the old behaviour already left behind.
delete from meganet.ingest_token_request where status = 'withdrawn';

-- ── Schema version ────────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 52 → 53 — but that bump ships only once this
-- migration has been applied, so an app build is never newer than the database
-- it talks to. (A mismatch is a non-fatal warning either way: datastore.js.)

insert into meganet.app_meta (key, value)
values ('schema_version', '53')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
