-- 0107_reading_raw_small_sample.sql — The submissions table's statistics from
-- a small sample, so refreshing them no longer reads the whole table.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0107_reading_raw_small_sample.sql
--
-- Why this file exists
-- ────────────────────
-- After Supabase's second Disk IO Budget warning (2026-11-08; 0106 has the
-- rest), the database's own counters were read an hour apart. Between 09:32
-- and 10:31 UTC the app, the agent API and the hourly jobs read about 16 MB
-- off the disk between them; autovacuum read 194 MB, nearly all of it one
-- automatic ANALYZE of meganet.reading_raw at 09:41.
--
-- ANALYZE samples 300 rows for each point of the statistics target, from as
-- many pages: at the default target of 100, 30,000 pages. reading_raw is
-- 25,598 pages (200 MB) — one submission's payload a row, kept 30 days — so
-- every ANALYZE reads all of it, and it had been analysed 25 times since
-- 19 October, about once a day, ~5 GB in all.
--
-- Nothing asks reading_raw anything its statistics would change the answer
-- to: it is read by id (reading.raw_id, retain()'s deletes) and by
-- received_at ranges (archive_due(), archive_rows(), retain()), each with a
-- btree of its own, and the planner reads the newest received_at from that
-- btree rather than from the histogram. A target of 10 is a 3,000-row sample
-- from at most 3,000 pages, about 23 MB. A column added to reading_raw later
-- starts at the default target and brings the whole-table sample back: set
-- it to 10 as well.
--
-- SET STATISTICS takes a lock that lets reads, inserts and deletes go on. The
-- ANALYZE at the end makes the new statistics now, reading the small sample
-- once.

alter table meganet.reading_raw
  alter column id              set statistics 10,
  alter column received_at     set statistics 10,
  alter column source          set statistics 10,
  alter column protocol        set statistics 10,
  alter column path            set statistics 10,
  alter column payload         set statistics 10,
  alter column frame           set statistics 10,
  alter column accepted        set statistics 10,
  alter column duplicates      set statistics 10,
  alter column rejected        set statistics 10,
  alter column submitted_by    set statistics 10,
  alter column ingest_token_id set statistics 10;

analyze meganet.reading_raw;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'meganet.reading_raw'::regclass
                and a.attnum > 0 and not a.attisdropped
                and coalesce(a.attstattarget, -1) <> 10) then
    raise exception '0107 did not take: a column of meganet.reading_raw is not at statistics target 10';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 107 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '107')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
