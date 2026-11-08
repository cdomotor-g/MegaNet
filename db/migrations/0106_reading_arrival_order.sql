-- 0106_reading_arrival_order.sql — Readings in the order they arrived, from an
-- index: the station-health run's "what came in since" and the latency map's
-- live feed read a page instead of re-sorting hours of readings for each one.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0106_reading_arrival_order.sql
--
-- Why this file exists
-- ────────────────────
-- Supabase wrote again on 2026-11-08 that the project is using up its Disk IO
-- Budget (the first time was 2026-10-28; 0087, 0089 and 0094 followed). In the
-- 24 hours before that email, 53 statements ran into their time limit, and the
-- largest group (25) was readings asked for by when they arrived:
--
--   - tools/health/report.mjs (station-health.yml, every fifteen minutes)
--     keeps the fortnight it read at the start of each six-hour slot and then
--     asks for every reading received since, a thousand at a time by offset,
--     ordered (received_at, addr, reading_ts, value_raw);
--   - map-latency.js's live feed asks for the readings received since its
--     last look, ordered by received_at.
--
-- No index held that order. Each page found its rows through
-- reading_received_brin, which is lossy — three hours back read 1,691 heap
-- pages to keep 3,262 of 34,231 rows — and sorted them again; 1.5 s a page
-- with every page already in memory. Late in a slot there are six hours to
-- read, seven pages of it, each doing all of that again, and a publishable-key
-- request is given 3 s. On 2026-11-07 the run failed this way every fifteen
-- minutes from 09:45 to 11:45 and from 14:45 to 17:45 UTC, and each failed
-- try had already read what it read (#275, opened by the CI doctor).
--
-- A btree in exactly that order serves each page from the index: no sort, and
-- only the rows asked for. Its leading column also lets roll_up() find what
-- arrived since its watermark as a range, and gives the planner the real
-- newest received_at instead of a guess from stale statistics (it guessed 61
-- rows for the 3,262 above). New readings arrive in received_at order, so
-- they are added at the index's right-hand edge — one page, kept in memory.
-- About 30–50 MB: reading_ts_idx's columns (0087, 24 MB) and one timestamp
-- more. Checked on Postgres 16 with 640,000 readings: a page of what arrived
-- in the last fifteen hours, 103 buffers from this index; without it the
-- lossy BRIN scan and a sort, and with nothing in the window, every heap page.
--
-- The index is built inside this file's transaction: meganet.reading takes
-- no new rows for the few seconds that takes, and ingest waits rather than
-- failing, as for 0087.

-- ── Readings in arrival order ────────────────────────────────────────────────

create index if not exists reading_received_idx
  on meganet.reading (received_at, addr, reading_ts, value_raw);

comment on index meganet.reading_received_idx is
  'Readings in arrival order (0106): the order tools/health/report.mjs reads what arrived since its base in — (received_at, addr, reading_ts, value_raw) — and map-latency.js''s live feed, so a page is read from the index, not sorted.';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_indexes
                  where schemaname = 'meganet' and indexname = 'reading_received_idx') then
    raise exception '0106 did not take: meganet.reading_received_idx is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 106 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '106')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
