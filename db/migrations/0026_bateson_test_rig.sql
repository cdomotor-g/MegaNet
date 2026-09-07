-- 0026_bateson_test_rig.sql — The workshop base station's own sensors, and the
-- address MegaNet reserves for proving the whole path end to end.
--
-- What this is for
-- ────────────────
-- `logger/base-station-http.CR300` has always been a relay: everything it posts
-- arrived over the air with an ALERT address already on it. The base station at
-- 18 Bateson now also has sensors bolted to the logger's own terminals — a
-- tipping bucket on the pulse input, two SDI-12 level sensors on C1, and the
-- supply voltage the logger already measures. Those readings have no ALERT
-- address, because there is no packet and no transmitting node, only a cable.
--
-- The ingest contract has carried the other address shape for them since 0006:
-- a `station_number` plus a `channel` saying which sensor at that number spoke
-- (docs/ingest-http.md, *Payload shape*). Nothing in the live system has ever
-- used it. This file is what makes it resolve to something a person can read,
-- and the same argument 0021 made for the ELPRO bench unit applies word for
-- word: a reading whose address resolves to nobody is still stored — 0008
-- decision 2 keeps it as an honest partial identity — but it does not appear as
-- a station's data, `station_health` accrues a row keyed by a bare string, and
-- the Message Log shows it unresolved. Correct for a station MegaNet has never
-- heard of, and useless for a rig whose entire job is to answer *did that land*.
--
-- The second thing this file is for
-- ─────────────────────────────────
-- A base station with no radio traffic cannot be shown to work. Everything from
-- the receiver to the app is exercised only by a real transmission, and a
-- workshop has none — which has meant that the one part of this system nobody
-- can test on demand is the part that carries every reading in it.
--
-- The logger can now transmit to itself: `TestInject` builds a complete, valid
-- ALERT2A frame and appends it to the receive byte buffer one instruction
-- before the framer runs, so the decoder, the queue, the batch, the POST, this
-- database and the Message Log all run on it exactly as they would on a real
-- one. `alert_id` 8101 below is the address it transmits as, and it is the
-- only thing that distinguishes a self-test reading from a real one — which is
-- deliberate. A path that knows it is being tested is not the path under test.
--
-- Why 8101 and not a 9000-block address like elpro_test's
-- ───────────────────────────────────────────────────────
-- Because this address goes on the wire, and 0021's did not. An ALERT2
-- concentration record carries **13 bits of address**: 9001 does not fit and
-- would silently wrap into the value field rather than fail. The highest real
-- address in the registry is 7999, so 8100–8109 is free, recognisably
-- synthetic, and transmittable — the only block that is all three. 8101 is the
-- self-test; 8102–8109 are reserved for the same purpose and this file is the
-- record of that.
--
-- The identifiers, and why these ones
-- ───────────────────────────────────
--   id              `bateson_test`  — the rig, not the site
--   station_number  `999998`        — outside the Bureau's range, one below the
--                                     115E-2's 999999. Real numbers are five or
--                                     six digits and none is either of these; a
--                                     test rig must not be able to collide with
--                                     a gauging station, and an obviously-fake
--                                     number says so on sight.
--   channels        rain, level_1, level_2, battery — the `channel` values on
--                                     the wire, so `s:999998/rain` and the
--                                     sensor row named `rain` are the same
--                                     string and a person can find one from the
--                                     other without a mapping table.
--
-- Why this is a SECOND row, when `18_bateson` already exists
-- ──────────────────────────────────────────────────────────
-- `18_bateson` is in stations.json: a surveyed field station in the network
-- document, with coordinates, a radio system and a role. This rig is a base
-- station and a bench at that address, and **its readings are not network
-- data** — rain measured in a workshop must never be able to be read as gauged
-- rainfall. Two rows keep those two facts apart, which is the same separation
-- 0021 drew and for the same reason.
--
-- It also keeps this file honest about the loader. `18_bateson` is
-- document-managed, so sensor rows added to it here would be deleted by the
-- next `load_stations_doc()` (0022 restated that prune four times over), and a
-- station_number set here would be overwritten by the document's empty one. The
-- alternative — flipping the surveyed station to `document_managed = false` —
-- would take a real station out of the document's control to make a test rig
-- work, which is the tail wagging the dog.
--
-- What this row is NOT
-- ────────────────────
-- It has no lat/lon, on the same reasoning 0021 used and for one more: the site
-- it stands at is already on the map as `18_bateson`, so coordinates here would
-- draw a second pin at the same house for a bench. The Message Log and Field
-- Data need an address and a station, not a position.
--
-- Retiring it: `update meganet.station set deleted_at = now() where id =
-- 'bateson_test';` — 0004's soft delete, which stops the document carrying it
-- and stops `resolve_station()` matching it, without deleting the readings it
-- explains.

-- ── The protocol ─────────────────────────────────────────────────────────────
-- Codes 0–5 are taken (0006 seeded 0–3, 0018 added 4 = hfem, 0021 added
-- 5 = elpro). A sensor on a terminal strip has no wire protocol at all, and
-- that is a fact worth recording rather than leaving as the batch envelope's
-- `alert2`, which would be untrue of every local reading in it. The Message Log
-- shows this column, so this is what stops a rain gauge on a cable being read
-- as a rain gauge on the air.
--
-- ⚠️ Ordering: `code_for()` RAISES on a protocol key it does not know, and
-- ingest() catches that per reading — so a logger running the new program
-- against a database without this row gets every local reading back in
-- `rejected` saying `unknown protocol: wired`, while the radio readings in the
-- same batch are stored. Legible rather than silent, and still a morning
-- wasted: apply this migration before loading the program.
insert into meganet.protocol (code, key, label) values
  (6, 'wired', 'A sensor wired to the logger''s own terminals — no radio protocol')
on conflict (code) do update set key = excluded.key, label = excluded.label;

-- ── The station ──────────────────────────────────────────────────────────────
-- `ord` is presentation order only and never identity (0002), so it goes on the
-- end. `roles` is `base`: this is an ingest point with sensors attached, and the
-- one thing it is not is a gauging station. `rm_system_id` is null (0022 made it
-- nullable for exactly this) because there is no radio path to model.
--
-- Written as an upsert rather than an update so it behaves the same on a
-- database built from zero — which is what CI does, applying every migration
-- before any station exists — as it does on the live one. 0021's insert failed
-- on precisely this and had to move to 0022; the shape below is 0022's, which
-- ran.
insert into meganet.station
  (id, ord, name, station_number, roles, rm_system_id, document_managed, enabled, notes)
select
  'bateson_test',
  coalesce(max(s.ord), 0) + 1,
  '18 Bateson workshop test rig',
  '999998',
  array['base']::text[],
  null,
  false,
  true,
  'The base station at 18 Bateson and the sensors wired to its logger — a '
  || 'tipping bucket, two SDI-12 level sensors and the supply voltage. Not a '
  || 'gauging station and not network data: it is where MegaNet''s ingest path '
  || 'is exercised live. Local channels post as station_number 999998 with a '
  || 'channel (s:999998/rain and so on); alert_id 8101 is the logger''s ALERT2 '
  || 'self-test, which builds a real frame and feeds it to its own decoder. '
  || 'See logger/README.md and docs/live-end-to-end-test.md. No lat/lon on '
  || 'purpose — the site itself is on the map as 18_bateson. Not in '
  || 'stations.json, so document_managed is false and a stations load leaves '
  || 'it alone (0022). Retire with update meganet.station set '
  || 'deleted_at = now() where id = ''bateson_test''.'
from meganet.station s
on conflict (id) do update
  set name             = excluded.name,
      station_number   = excluded.station_number,
      roles            = excluded.roles,
      rm_system_id     = excluded.rm_system_id,
      document_managed = excluded.document_managed,
      enabled          = excluded.enabled,
      notes            = excluded.notes,
      deleted_at       = null,
      updated_at       = now();

-- ── The sensors ──────────────────────────────────────────────────────────────
-- Four local channels and one self-test address, and they resolve by two
-- different routes on purpose:
--
--   the four channels  resolve through station.station_number — `channel` is
--                      not matched against anything, it only says which sensor
--                      at that number spoke. So `alert_id` is null on all four,
--                      which the column has allowed since 0002 (927 sensors in
--                      the registry have no ALERT address either).
--   8101               resolves through meganet.sensor.alert_id, which is what
--                      resolve_station() matches an incoming ALERT address
--                      against — station.alert_ids is not consulted.
--
-- `sensor_id` is the bare channel name rather than a `541155.0.R.6128`-style
-- identifier, because for these rows the channel name IS the identifier: it is
-- half of every reading's address, so making the two the same string is what
-- lets somebody looking at `s:999998/level_1` find the row without a lookup.
--
-- `type` is free text that the app displays and filters on (bit-flipper.js), so
-- `Self-test` gives the 8101 address a label of its own rather than dressing it
-- as Rainfall — a synthetic address that looks like a rain gauge in the Bit
-- Flipper is a trap laid for whoever reads it next.
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('bateson_test', 'rain',            'Rainfall',    1, null),
  ('bateson_test', 'level_1',         'Water Level', 2, null),
  ('bateson_test', 'level_2',         'Water Level', 3, null),
  ('bateson_test', 'battery',         'Battery',     4, null),
  ('bateson_test', 'alert2_selftest', 'Self-test',   5, 8101)
on conflict (station_id, sensor_id, type) do update
  set alert_id   = excluded.alert_id,
      ord        = excluded.ord,
      updated_at = now();

-- ── Check ────────────────────────────────────────────────────────────────────
-- Fail the migration rather than leave a half-made rig behind. Both routes are
-- asserted, because either one alone is a station that answers for half of what
-- it is sent and sends the operator looking at the logger.
--
-- Note what the first check also proves: that 999998 is unique. resolve_station
-- returns null rather than guessing when a number is carried by more than one
-- station, so a second row claiming this number fails here rather than silently
-- unresolving every reading the rig has ever sent.
do $$
begin
  if meganet.resolve_station(null, '999998') is distinct from 'bateson_test' then
    raise exception '0026 did not take: resolve_station(null, ''999998'') = %',
      coalesce(meganet.resolve_station(null, '999998'), '(null)');
  end if;
  if meganet.resolve_station(8101, null) is distinct from 'bateson_test' then
    raise exception '0026 did not take: resolve_station(8101) = %',
      coalesce(meganet.resolve_station(8101, null), '(null)');
  end if;
  if not exists (select 1 from meganet.protocol where key = 'wired') then
    raise exception '0026 did not take: protocol ''wired'' is missing';
  end if;
  if not exists (
    select 1 from meganet.station where id = 'bateson_test' and not document_managed) then
    raise exception '0026 did not take: bateson_test is missing or is document-managed';
  end if;
end
$$;

-- ── The rig, end to end, in one statement ────────────────────────────────────
-- Left here rather than in a doc because it is the query the whole file exists
-- to make answerable, and a query that lives beside the rows it reads does not
-- go stale when they move:
--
--   select r.addr, r.reading_ts, r.value_raw, r.value, r.unit, p.key as protocol,
--          r.source, r.path, r.received_at
--     from meganet.reading r
--     join meganet.protocol p on p.code = r.protocol
--    where r.station_id = 'bateson_test'
--    order by r.received_at desc
--    limit 20;
--
-- Five addresses should appear over a five-minute window with the self-test
-- fired once: s:999998/rain, /level_1, /level_2, /battery and a:8101.

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 25 → 26 in the same commit as this file.
-- 0013's note records why that is said here rather than remembered: 0012 bumped
-- the database and missed the app, and the app showed a schema-mismatch banner
-- until #147 found it.

insert into meganet.app_meta (key, value)
values ('schema_version', '26')
on conflict (key) do update set value = excluded.value;
