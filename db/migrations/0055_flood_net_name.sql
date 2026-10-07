-- 0055_flood_net_name.sql — The app is Flood-Net: the words the database
-- itself puts in front of people say so too.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0055_flood_net_name.sql
--
-- Roadmap revision 115 renamed the app from MegaNet to Flood-Net everywhere the
-- code puts words on a screen, a download or the agent API. A few of those words
-- are not in the code: they are rows and return values here, written by earlier
-- migrations. This rewrites exactly those, and nothing a person does not read —
-- the schema keeps its name, as do the functions, the comments, the MQTT topics
-- and every identifier (README.md, "The app is Flood-Net").
--
-- Every statement is a no-op the second time: the replaces find nothing left to
-- replace, and the function is the same text again.

-- ── 1. The Bateson test rig's note (0026) ────────────────────────────────────
-- On its station card, and in stations.json once the weekly snapshot runs.

update meganet.station
   set notes = pg_catalog.replace(notes, 'MegaNet', 'Flood-Net')
 where id = 'bateson_test'
   and notes like '%MegaNet%';

-- ── 2. stations.json's meta.description ──────────────────────────────────────
-- The header of the public document; the snapshot writes it from this row.

update meganet.doc_meta
   set description = pg_catalog.replace(description, 'MegaNet', 'Flood-Net')
 where description like '%MegaNet%';

-- ── 3. What became of a file sent in (0036) ──────────────────────────────────
-- A public lookup: the outcome labels anyone reading the table through the API
-- sees. The app words its own, but the two should not disagree about the name.

update meganet.field_photo_outcome
   set label = pg_catalog.replace(label, 'MegaNet', 'Flood-Net')
 where label like '%MegaNet%';

-- ── 4. Why a base station request was refused (0054) ─────────────────────────
-- admin_base_station_command() refuses with this sentence, and the Base Stations
-- tab shows it. 0054's body exactly, but for the two sentences that named the app.

create or replace function meganet.base_station_verb_check(p_verb text, p_args jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_patch jsonb;
begin
  if p_args is null or pg_catalog.jsonb_typeof(p_args) <> 'object' then
    return 'the request''s arguments are an object';
  end if;
  if pg_catalog.octet_length(p_args::text) > 8192 then
    return 'the request''s arguments are at most 8 KB';
  end if;
  case coalesce(p_verb, '')
    when 'status', 'device.rescan', 'send-now', 'stations.refresh', 'agent.restart', 'reboot',
         'update.check', 'update.install', 'access.sync' then
      return null;
    when 'log' then
      if p_args ? 'lines' and (pg_catalog.jsonb_typeof(p_args -> 'lines') <> 'number'
                               or (p_args ->> 'lines')::numeric not between 1 and 400) then
        return 'log: lines, 1–400';
      end if;
      return null;
    when 'config.set' then
      v_patch := p_args -> 'patch';
      if v_patch is null or pg_catalog.jsonb_typeof(v_patch) <> 'object' or v_patch = '{}'::jsonb then
        return 'config.set: the settings to change, as an object';
      end if;
      if v_patch ?| array['web', 'hotspot', 'remote', 'version'] then
        return 'the web page''s password and port, its own Wi-Fi network, and what the base station lets Flood-Net do, are set on the base station itself';
      end if;
      if v_patch ? 'meganet' and (pg_catalog.jsonb_typeof(v_patch -> 'meganet') <> 'object'
          or exists (select 1 from pg_catalog.jsonb_object_keys(v_patch -> 'meganet') k where k not in ('enabled', 'receptions'))) then
        return 'of the Flood-Net settings, only whether to send (enabled, receptions) may be changed from here — never the token or where readings go';
      end if;
      return null;
    when 'device.restart', 'device.forget' then
      if pg_catalog.jsonb_typeof(p_args -> 'key') <> 'string' or pg_catalog.length(p_args ->> 'key') not between 1 and 200 then
        return p_verb || ': key — the receiver''s, as its status names it';
      end if;
      return null;
    when 'update.auto' then
      if pg_catalog.jsonb_typeof(p_args -> 'on') <> 'boolean' then
        return 'update.auto: on, true or false';
      end if;
      return null;
    else
      return 'a base station cannot be asked to "' || pg_catalog.left(coalesce(p_verb, ''), 40) || '"';
  end case;
end;
$$;

-- ── Schema version ────────────────────────────────────────────────────────────
-- Apply after 0054. core.js DB_SCHEMA_VERSION follows (to 55) once it is live.
insert into meganet.app_meta (key, value)
values ('schema_version', '55')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
