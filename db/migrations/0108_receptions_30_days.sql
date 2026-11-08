-- 0108_receptions_30_days.sql — Receptions kept 30 days in the database
-- instead of 90; every one stays in the R2 archive and in the rollups.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0108_receptions_30_days.sql
--
-- Why this file exists
-- ────────────────────
-- #256, the owner's choice (b), 2026-11-08, after Supabase's second Disk IO
-- Budget warning (0106, 0107). Receptions arrive at about 80,000 a day
-- (59,000–93,000 since 29 October), about 440 bytes each with their
-- indexes: 90 days of them is near 3 GB, more than the memory of the Small
-- compute size the owner chose on #255; 30 days is near 1 GB.
--
-- Nothing is lost. retain() (0073, 0074) deletes a day only once it is past
-- the horizon, archived to R2 at exactly the rows it has now, and rolled up
-- to that count, and at most 200,000 rows a table a night. The first days to
-- go, 3–9 October, were all archived on 21 October at their rolled-up
-- counts (about 56,000 rows). After that it is one day a night.
--
-- What reads raw receptions reads at most a week back: the Reception Map
-- and the latency map 7 days, Signal Routes 7, the Base Stations waterfall
-- 48 hours, Hops to base 12 hours. The longer views — transmitter drift
-- (38 days), the SNR trend (97), a base station's channels (up to 90), the
-- flip summaries — read carrier_daily, flip_event and the reception rollups,
-- which are kept for good. roll_up_carriers(from, to) after a register edit
-- reaches only days still in the table, now the last 30.
--
-- Deleted rows free space inside the table for the next ones rather than
-- shrinking its file: the table stops growing once it holds 30 days.

insert into meganet.app_meta (key, value)
values ('retain_reception_days', '30')
on conflict (key) do update set value = excluded.value;

comment on function meganet.retain(integer) is
  'Roll up (readings and receptions), then delete — only days that are past their table''s horizon (retain_reading_days 730, retain_reading_raw_days 30, retain_reception_days 30 since 0108, 90 before), archived to R2 at exactly their row count now, and rolled up to it (0073, #243). At most p_max_rows a table a run; a released day is finished by the next. pg_cron daily (meganet-retain).';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if (select a.value from meganet.app_meta a where a.key = 'retain_reception_days') is distinct from '30' then
    raise exception '0108 did not take: retain_reception_days is not 30';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 108 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '108')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
