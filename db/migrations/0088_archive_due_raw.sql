-- 0088_archive_due_raw.sql — The archive's list of submission days due,
-- counted only where a count can change what happens (#243).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0088_archive_due_raw.sql
--
-- Why this file exists
-- ────────────────────
-- The nightly archive (archive-r2.yml) failed on 2026-10-25, -28 and -29 at its
-- first call: archive_due('reading_raw') hit PostgREST's 8 s statement timeout
-- and nothing was archived. 0074 left submissions the one table still counted
-- row by row — every row kept, every night, grouped by day — and on
-- 2026-10-29 that was 153,462 rows in 10.0 s (78,844 heap fetches, 8,680 pages
-- off a disk Supabase is throttling, 0087). A single day is ~11,000 rows and
-- 1.1 s, so 30 kept days cannot be counted inside 8 s on this compute however
-- well vacuumed, and the table only grows with the traffic.
--
-- Most of that counting decides nothing. A submission day is offered when it
-- is not archived at its count now; but an archived day inside its 30 days
-- is not deleted by retain() whatever its count, and the day it crosses the
-- horizon is the night retain() counts it again before releasing it. So a
-- submission day is now counted only when it
--
--   • has never been archived — a new day, or one a failed run left behind; or
--   • is archived, not yet released, and past retain_reading_raw_days — the
--     days retain() is about to release, where a late row must be caught.
--
-- An archived day still inside its horizon is not recounted every night: a
-- late row in it (a received_at a relay passed through from upstream) is found
-- when the day reaches the horizon, archived then as the next version, and
-- released the night after — never deleted before it is archived, as 0073
-- has it. No day had changed after its archive when this was written: every
-- version in the manifest was 1.
--
-- The days are found one index probe a day (reading_raw_received_idx, the
-- next received_at after each day) — 28 days in 65 ms — and the counting
-- stops at 4 s, leaving the newer days for the next run, so a backlog after
-- an outage is worked off a few days a night rather than timing out every
-- night. Readings and receptions still count from their daily rollups (0074).

-- ── Counting by day ──────────────────────────────────────────────────────────

create or replace function meganet.archive_day_counts_fast(p_table text, p_before date)
returns table (day date, rows bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_horizon date;
  v_day     date;
begin
  case p_table
    when 'reading' then
      return query select h.bucket, pg_catalog.sum(h.n)::bigint
        from meganet.reading_daily h where h.bucket < p_before group by 1;
    when 'reception' then
      return query select h.bucket, pg_catalog.sum(h.n)::bigint
        from meganet.reception_daily h where h.bucket < p_before group by 1;
    when 'reading_raw' then
      v_horizon := ((pg_catalog.now() at time zone 'UTC')::date)
                   - coalesce((select a.value::integer from meganet.app_meta a
                                where a.key = 'retain_reading_raw_days'), 30);
      select (pg_catalog.min(r.received_at) at time zone 'UTC')::date into v_day
        from meganet.reading_raw r;
      while v_day is not null and v_day < p_before loop
        exit when pg_catalog.clock_timestamp() - pg_catalog.statement_timestamp() > interval '4 seconds';
        if not exists (select 1 from meganet.archive_day a
                        where a.table_name = 'reading_raw' and a.day = v_day)
           or (v_day < v_horizon
               and not exists (select 1 from meganet.archive_day a
                                where a.table_name = 'reading_raw' and a.day = v_day and a.released_at is not null)) then
          return query select v_day, meganet.archive_day_count('reading_raw', v_day);
        end if;
        select (pg_catalog.min(r.received_at) at time zone 'UTC')::date into v_day
          from meganet.reading_raw r
         where r.received_at >= ((v_day + 1)::timestamp at time zone 'UTC');
      end loop;
    else
      raise exception 'not a table the archive keeps: %', p_table using errcode = '22023';
  end case;
end;
$$;

comment on function meganet.archive_day_counts_fast(text, date) is
  'Rows a day for the UTC days before p_before that archive_due() should weigh (0074, 0088): readings and receptions from their daily rollups, every day; submissions from the table, but only days never archived and archived days past retain_reading_raw_days not yet released — found one index probe a day, counted until 4 s have gone. archive_record() and retain() count the rows themselves.';

revoke all on function meganet.archive_day_counts_fast(text, date) from public;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.archive_day_counts_fast(text, date)'::regprocedure),
                       'retain_reading_raw_days') = 0 then
    raise exception '0088 did not take: archive_day_counts_fast() is still 0074''s';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '88')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
