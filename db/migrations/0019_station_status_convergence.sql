-- 0019_station_status_convergence.sql — One station, one health row.
--
-- #162, found by the #102 audit. meganet.station_status is written by two
-- paths, and they agreed about the key only when resolution succeeded:
--
--   MQTT  (mqtt_status / mqtt_seen, 0008)  keys by the <station> topic
--         segment — which the topic scheme defines to BE the station id, so a
--         correctly-configured logger's row is keyed by the id.
--   HTTP  (ingest_http's bookkeeping, 0012) keys by the resolved station id —
--         or by 'a:<alert address>' / 's:<station number>' when the address
--         resolves to no one station.
--
-- So the twins are born at the boundary of the registry: a station that is
-- heard before MegaNet is told about it accrues rows under its transport
-- identities (the topic segment from MQTT, the address form from HTTP), and
-- when it is finally registered, NEW writes converge on the id while the old
-- rows sit frozen beside them — two or three station_key rows for one
-- physical site, whose online / since / last_seen_at diverge, and anything
-- reading meganet.station_health joins whichever it happens to hit.
--
-- The keying decision, stated once and now written on the table:
--
--   * The canonical key is station.id, from the moment the identity resolves.
--     Both writers already do this — no writer changes in this migration.
--   * Until it resolves, the key is the identity the transport actually had:
--     the topic segment from MQTT, 'a:'/'s:' address forms from HTTP. A row
--     for a station the registry does not know yet is still a fact, and
--     inventing an id for it would be worse than keeping the honest partial
--     identity (0008's decision 2, unchanged).
--   * The moment resolution starts succeeding, the old rows FOLD into the
--     canonical one — meganet.station_status_converge(), below. This file
--     runs it once over what exists; tools/import_stations_json.py runs it
--     after every registry sync, which is the event that makes a previously
--     unresolvable key resolvable.
--
-- Forward-only, idempotent, no begin/commit — db/README.md holds the rules.

-- ── The fold ─────────────────────────────────────────────────────────────────

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
  -- stays unresolved rather than guessed), and a row an earlier convention
  -- resolved under a non-canonical key folds into its own station_id.
  for r in
    select ss.*,
           coalesce(
             case when ss.station_id is not null and ss.station_id <> ss.station_key
                  then ss.station_id end,
             case when ss.station_key ~ '^a:[0-9]+$'
                  then meganet.resolve_station(substring(ss.station_key from 3)::integer, null) end,
             case when ss.station_key like 's:%'
                  then meganet.resolve_station(null, substring(ss.station_key from 3)) end)
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

comment on function meganet.station_status_converge() is
  'Fold station_status rows keyed by a transport identity (topic segment, a:/s: address form) into the canonical station-id row, once the identity resolves. Run after a registry sync — tools/import_stations_json.py appends the call — and safe to run any time; a key that still resolves to nothing is left as the honest partial identity it is (#162).';

-- ── The convention, written where readers look ──────────────────────────────

comment on table meganet.station_status is
  'What the last thing to speak for each station said about it: an MQTT retained status or LWT from the bridge (0008), or the arrival of a batch through an ingest point (0012). Keyed canonically by station.id from the moment the identity resolves; until then by the identity the transport had — the <station> topic segment from MQTT, a:<alert address> / s:<station number> from HTTP. Rows fold into the canonical key when resolution starts succeeding: meganet.station_status_converge() (#162).';
comment on column meganet.station_status.station_key is
  'station.id where the identity resolves (both writers agree on this). Otherwise the identity the transport had: the <station> topic segment from MQTT; a:<alert address> or s:<station number> from HTTP ingest. Never contains + # or /. Folded to the id by station_status_converge() once resolution succeeds.';

-- ── Who may run it ───────────────────────────────────────────────────────────

revoke all on function meganet.station_status_converge() from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.station_status_converge() to authenticated, service_role;
end
$$;

-- ── The data migration: converge what exists today ───────────────────────────

do $$
declare
  v jsonb;
begin
  v := meganet.station_status_converge();
  raise notice 'station_status convergence: % row(s) folded', v ->> 'folded';
end
$$;

notify pgrst, 'reload schema';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $do$
begin
  if pg_catalog.to_regprocedure('meganet.station_status_converge()') is null then
    raise exception '0019 did not take: station_status_converge() is missing';
  end if;
  -- After convergence, no row may carry a station_id different from its key
  -- when that id is a live station — that is the twin shape this file exists
  -- to remove.
  if exists (select 1 from meganet.station_status ss
              join meganet.station st on st.id = ss.station_id and st.deleted_at is null
             where ss.station_key <> ss.station_id) then
    raise exception '0019 did not take: a resolved row still keys by a non-canonical identity';
  end if;
end
$do$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 18 → 19 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '19')
on conflict (key) do update set value = excluded.value;
