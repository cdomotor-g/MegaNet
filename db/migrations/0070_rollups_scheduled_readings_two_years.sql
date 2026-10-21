-- 0070_rollups_scheduled_readings_two_years.sql — The rollups built on a
-- schedule, and raw readings kept two years rather than ninety days.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0070_rollups_scheduled_readings_two_years.sql
--
-- Why this file exists
-- ────────────────────
-- 0006 designed retention in before the first row: meganet.roll_up() builds
-- reading_hourly and reading_daily (kept forever), meganet.retain() rolls up
-- and then ages the raw rows out. Both were left to be run by hand "while no
-- real traffic exists". Real traffic arrived in October — ~26k readings and
-- ~95k receptions a day by the 21st, the database at 468 MB and growing ~80 MB
-- a day — and neither had ever run: both rollup tables were empty, so the
-- Field Data tab's wide windows had nothing to draw from.
--
-- Two decisions, the owner's (2026-10-21):
--
-- **1. Raw readings are kept two years, not ninety days.** A water level or a
-- battery voltage is the most valuable thing this database holds, and at
-- ~10 MB a day two years of it is affordable. retain_reading_days goes to 730.
-- roll_up() reads the same knob for its horizon, so it now rebuilds any hour
-- inside two years.
--
-- **2. roll_up() runs hourly; retain() still does not run on a schedule.**
-- roll_up() deletes nothing and is idempotent, so scheduling it is safe on its
-- own. retain() deletes, and the rule agreed with the owner is that nothing is
-- deleted that has not been both summarised and archived to R2. The archive
-- does not exist yet (its issue is on the roadmap, after the reception
-- rollups), so scheduling retain() waits for it. Until then reading_raw keeps
-- growing past its 30 days (~6 MB a day) — the price of the rule, and small.
--
-- Minute 7 of each hour: clear of the */5 jobs' :00 and :05, and after the
-- hour it rolls up has closed. cron.schedule() replaces a job of the same
-- name, so a re-apply changes nothing. Skipped where the server has no
-- pg_cron (CI's postgres:16), as 0059 and 0062 do. pg_cron runs the job as the
-- database owner over a direct connection, which meganet.is_editor() admits.

-- ── Readings kept two years ──────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('retain_reading_days', '730')
on conflict (key) do update set value = excluded.value;

-- ── The rollups, hourly ──────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.roll_up() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-roll-up', '7 * * * *', 'select meganet.roll_up()');
    raise notice 'meganet.roll_up() runs hourly at minute 7 (pg_cron job meganet-roll-up).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): the rollups will not be built until it is.', sqlerrm;
  end;
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if (select a.value from meganet.app_meta a where a.key = 'retain_reading_days') is distinct from '730' then
    raise exception '0070 did not take: retain_reading_days is not 730';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 70 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '70')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
