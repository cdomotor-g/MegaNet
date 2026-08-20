-- 0021_elpro_test_station.sql — A station for the ELPRO 115E-2 test unit, and
-- a protocol code for what it speaks.
--
-- Why a station row exists for a bench unit
-- ─────────────────────────────────────────
-- The 115E-2 test unit is being configured by a technician in another office,
-- against our broker, with nobody from this project in the room. The whole
-- point of the exercise is that they get an answer — *did that land?* — over
-- the phone, in the app, within a minute of pressing Save.
--
-- That answer only exists if the readings resolve to a station. A reading whose
-- address resolves to nobody is still stored (0008 decision 2 keeps it as an
-- honest partial identity rather than inventing an id for it), but it does not
-- appear as a station's data, `station_health` accrues a row keyed by a bare
-- string, and the Message Log shows it as unresolved. That is the correct
-- behaviour for a station MegaNet has never heard of, and it is a terrible
-- experience for a commissioning test where the answer needs to be legible to
-- somebody who is not going to read this file.
--
-- So the test unit gets a real row, and the test *is* the thing the row is for.
--
-- The identifiers, and why these ones
-- ───────────────────────────────────
--   id              `elpro_test`  — the publisher segment, so the MQTT topic is
--                                   meganet/v1/elpro_test/logger/reading/elpro
--   station_number  `999999`      — deliberately outside the bureau's range.
--                                   Real numbers in the registry are 5–6 digits
--                                   and none is 999999; a test rig must not be
--                                   able to collide with a gauging station, and
--                                   an obviously-fake number says so on sight.
--   alert_ids       9001–9003     — the highest real ALERT address in the
--                                   registry is 7999, so the 9000 block is free
--                                   and stays recognisably synthetic.
--
-- 0020 says a site publishes under its bureau number, falling back to its
-- station id for the things that have none. This row has BOTH, which looks like
-- a contradiction and is not: `resolve_publisher()` prefers the number, so the
-- unit could publish as either. It publishes as `elpro_test` because that is
-- what a person reading a broker log needs to see, and the number is here so
-- the row is well-formed and so a later test can flip to it without a migration.
--
-- What this row is NOT
-- ────────────────────
-- It has no lat/lon, on purpose. There is no site. Giving a bench unit
-- coordinates would put a pin on the map that means nothing and would have to be
-- remembered and removed; leaving them null puts it in the app's own
-- "missing lat/lon" filter, which is exactly what it is. The Message Log and
-- Field Data need an address and a station, not a position.
--
-- Retiring it: `update meganet.station set deleted_at = now() where id =
-- 'elpro_test';` — 0004's soft delete, which stops the document carrying it and
-- stops `resolve_station()` matching it, without deleting the readings it
-- explains.

-- ── The protocol ─────────────────────────────────────────────────────────────
-- Codes 0–4 are taken (0006 seeded 0–3, 0018 added 4 = hfem). ELPRO's plain
-- MQTT is its own wire format — a JSON object of `timestamp` plus free-text
-- label/value pairs — and naming it is what lets the Message Log say which of
-- the three MQTT payload shapes a row arrived as, rather than showing every
-- bridge row as `mqtt` and leaving the reader to guess.
insert into meganet.protocol (code, key, label) values
  (5, 'elpro', 'ELPRO 115E-2 / x15U MQTT gateway, plain (non-Sparkplug) JSON')
on conflict (code) do update set key = excluded.key, label = excluded.label;

-- ── The station ──────────────────────────────────────────────────────────────
-- `ord` is presentation order only and never identity (0002), so it goes on the
-- end. `roles` is `base` rather than `field`: a 115E-2 is a gateway, and the one
-- thing this test is not is a gauging station.
insert into meganet.station
  (id, ord, name, station_number, roles, rm_system_id, enabled, notes)
select
  'elpro_test',
  coalesce(max(s.ord), 0) + 1,
  'ELPRO 115E-2 test unit',
  '999999',
  array['base']::text[],
  1,
  true,
  'Bench/test gateway, not a site. Exists so the 115E-2 MQTT trial has somewhere '
  || 'to land that a person can read: see docs/elpro115e_test_card.md for the '
  || 'technician''s half and docs/elpro115e_mqtt.md for the full provisioning '
  || 'guide. Publishes as elpro_test on meganet/v1/elpro_test/logger/reading/elpro. '
  || 'No lat/lon on purpose — there is no site. Retire with '
  || 'update meganet.station set deleted_at = now() where id = ''elpro_test''.'
from meganet.station s
on conflict (id) do update
  set name           = excluded.name,
      station_number = excluded.station_number,
      roles          = excluded.roles,
      enabled        = excluded.enabled,
      notes          = excluded.notes,
      deleted_at     = null,
      updated_at     = now();

-- ── The sensors ──────────────────────────────────────────────────────────────
-- `resolve_station()` matches an incoming `alert_id` against meganet.sensor, not
-- against station.alert_ids — so without these rows an address resolves to
-- nobody and the reading files under a bare number. Three, because the test card
-- asks the technician to publish three values: a level, a rainfall count and the
-- unit's own supply voltage. The last one is the useful one to start with, since
-- the gateway can report its own battery without anything being wired to it.
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('elpro_test', 'elpro_test_level',   'Water Level', 1, 9001),
  ('elpro_test', 'elpro_test_rain',    'Rainfall',    2, 9002),
  ('elpro_test', 'elpro_test_battery', 'Battery',     3, 9003)
on conflict (station_id, sensor_id, type) do update
  set alert_id   = excluded.alert_id,
      ord        = excluded.ord,
      updated_at = now();

-- ── Check ────────────────────────────────────────────────────────────────────
-- Fail the migration rather than leave a half-made station behind: a test rig
-- that silently did not resolve would send the technician looking at the device.
do $$
begin
  if meganet.resolve_station(9003, null) is distinct from 'elpro_test' then
    raise exception 'elpro_test did not take: resolve_station(9003) = %',
      coalesce(meganet.resolve_station(9003, null), '(null)');
  end if;
  if meganet.resolve_publisher('elpro_test') is distinct from 'elpro_test' then
    raise exception 'resolve_publisher(''elpro_test'') = %',
      coalesce(meganet.resolve_publisher('elpro_test'), '(null)');
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 20 → 21 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '21')
on conflict (key) do update set value = excluded.value;
