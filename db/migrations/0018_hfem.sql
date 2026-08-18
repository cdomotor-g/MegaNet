-- 0018_hfem.sql — The HFEM vocabulary rows: a protocol, a quality, two units.
--
-- #155 (EPIC #152). 0006 was built so that a new wire protocol is rows rather
-- than DDL, and this migration takes it at its word: no new table, no new
-- column, no change to meganet.ingest(). The decoder lives at the edge
-- (hfem.js, one file for the browser and the bridge — #153's design decision),
-- the mapping to the ingest contract lives beside it (HFEM.toReadings), and
-- what the database needs is only the vocabulary to accept what they send.
--
-- What is deliberately NOT here:
--
--   * No meganet.ingest_source 'tcp' row. #152's open question 1 — does any
--     logger actually need a raw socket? — is unanswered, and a vocabulary row
--     for a transport nobody has committed to build is the row that documents
--     an intention instead of a fact. If the answer comes back "raw socket",
--     the row arrives with the listener that uses it.
--
--   * No 'ppm' unit. HFEM states Dissolved Oxygen in ppm (Table 4); meganet
--     .unit carries mg/L, and in fresh water the two are numerically
--     equivalent (1 mg/L = 1 ppm at water's density). One quantity, one name:
--     the mapping renames ppm → mg/L on the way in (hfem.js toReadings), and
--     this comment is the place that records the equivalence. A second key for
--     the same measure would make "plot the dissolved oxygen" a two-unit join
--     forever. (#152 trap 4.)
--
-- Forward-only, idempotent, no begin/commit — db/README.md holds the rules.

-- ── Protocol ─────────────────────────────────────────────────────────────────
-- Codes 0–3 are taken (unknown, alert, alert2, arro — 0006).

insert into meganet.protocol (code, key, label) values
  (4, 'hfem', 'BoM Hydro Field Event Message — :HS=1|…|NN: (v1.0, 2010)')
on conflict (code) do update set key = excluded.key, label = excluded.label;

-- ── Quality ──────────────────────────────────────────────────────────────────
-- Codes 0–5 are taken (0006). HFEM's M=1 means the site is being worked on:
-- the reading is real, the instrument answered, but a technician pouring a
-- calibration bucket through a rain gauge is not weather. That is not
-- 'suspect' — nothing doubts the measurement — and it is not 'bad'. It is a
-- true value of a deliberately disturbed instrument, and analyses need to
-- exclude it by name rather than by guessing at step changes (#152 trap 2).

insert into meganet.quality (code, key, label) values
  (6, 'maintenance', 'Measured during maintenance (HFEM M=1) — real, but the site was being worked on')
on conflict (code) do update set key = excluded.key, label = excluded.label;

-- ── Units ────────────────────────────────────────────────────────────────────
-- The two HFEM sensor classes 0006's seed list does not cover: Solar
-- Radiation (W/m2) and Gas Pressure (MPa — Table 4's cell says 'mPa', its
-- description says megapascals, and a gas-purge line runs at megapascal order,
-- so mega it is; hfem.js records the same divergence). Everything else in
-- Table 4 maps onto a unit 0006 already carries.

insert into meganet.unit (key, label) values
  ('W/m2', 'Watts per square metre — solar radiation'),
  ('MPa',  'Megapascals — gas-purge pressure')
on conflict (key) do update set label = excluded.label;

notify pgrst, 'reload schema';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $do$
begin
  if not exists (select 1 from meganet.protocol where code = 4 and key = 'hfem') then
    raise exception '0018 did not take: protocol 4 (hfem) is missing';
  end if;
  if not exists (select 1 from meganet.quality where code = 6 and key = 'maintenance') then
    raise exception '0018 did not take: quality 6 (maintenance) is missing';
  end if;
  if (select count(*) from meganet.unit where key in ('W/m2', 'MPa')) <> 2 then
    raise exception '0018 did not take: W/m2 or MPa is missing from meganet.unit';
  end if;
end
$do$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 17 → 18 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '18')
on conflict (key) do update set value = excluded.value;
