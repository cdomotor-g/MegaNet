-- 0034_sls_edition.sql — The Service Level Specification moves from version
-- 3.1 (September 2018) to 3.7 (December 2025), and the schema stops naming an
-- edition.
--
-- Why this file exists
-- ────────────────────
-- The SLS is data, not schema. Version 3.7 reaches meganet.sls_row through
-- meganet.load_sls_from_url() exactly as 3.1 did (0028): the same six
-- schedules, the same columns, and meganet.sls_doc says which edition the rows
-- are. Nothing about their shape changed.
--
-- Two comments in the schema did name the old edition, though, and stopped
-- being true when 3.7 was loaded: meganet.station.owner said the card falls
-- back to "the 2018 SLS" (0030), and meganet.sls_row.priority counted the
-- numbers whose schedules disagree as 42, which is 3.1's figure (3.7's is 55).
-- A comment is the schema's own documentation — it is what \d+ and the
-- Supabase table editor show — so the fix is a migration. The new wording names
-- no edition and counts nothing, so the next edition needs no migration.
--
-- meganet.sls_doc also gains where the Bureau publishes the document. Its URL
-- for the current edition is stable, and "where did these rows come from?"
-- should be answerable without the repository.
--
-- No data. Idempotent and forward-only, per db/README.md.

comment on table meganet.sls_doc is
  'Which edition of the Queensland Service Level Specification meganet.sls_row was read from. Exactly one row. The Bureau publishes the current edition at https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf; archive/QLD_SLS_current.pdf in the MegaNet repository is the copy these rows were read from.';

comment on column meganet.sls_row.priority is
  'The impact of losing this site, per the schedule this row came from. The schedules can disagree about a site; meganet.sls_location takes the highest.';

comment on column meganet.station.owner is
  'Who owns the station, as written on the card — e.g. "Toowoomba Regional Council". Null means not recorded on the station, in which case the card falls back to the owner the SLS gives (data/sls-locations.json).';

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 33 → 34 in the same commit as this file.
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '34')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
