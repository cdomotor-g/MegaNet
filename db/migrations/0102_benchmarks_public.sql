-- 0102_benchmarks_public.sql — The Bureau's benchmarks in numbers, for anybody:
-- each mark's level and datum, what it reads on the gauge and the zero that
-- was worked from, and the survey mark's number where the description gives
-- one — and not what the mark is or where it is.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0102_benchmarks_public.sql
--
-- Why this file exists
-- ────────────────────
-- 0101 put HDB's benchmark details on the stations for editors only, because a
-- benchmark's description and its comments say where it is to the tree and the
-- gate post ("TBM bolt in Pepperina tree right hand side of house") and some
-- carry its coordinates — 0060's rule. The agent API (worker/api.js) reads only
-- what `anon` can, so it had none of it. The owner's call (4 November 2026):
-- publish the numbers and keep the words. This view is that line, drawn once.
--
-- Why it reads past the policy
-- ────────────────────────────
-- 0023's reasoning, for 0023's reason: an invoker view over
-- meganet.bureau_benchmark answers `anon` nothing however it is granted,
-- because `anon` has no SELECT policy on the table — which is right for a view
-- meaning "the same rows, a narrower shape" and wrong for one meaning "these
-- columns, published". So this one runs as its owner, and what it publishes is
-- fixed here and checked at apply time (below) and again by
-- tools/check_station_benchmarks.sql on every CI run.
--
-- What is published, exactly
-- ──────────────────────────
--   · which live station, by its id and number, and the bureau number HDB
--     prints, and the order the report lists the station's marks in;
--   · `mark`: the survey mark's number, where the description opens a known
--     kind of one — PSM 46757, SSM, PM, SD 89025, CGC200041, BM6001 —
--     meganet.benchmark_mark()'s rule. A State or council mark's number is
--     already public, in the register that holds its position; the words
--     around it are what stay behind;
--   · its level and datum, as printed;
--   · the gauge zero in force and its datum and start, and `on_gauge_m` where
--     the two datums agree — 0101's view, the same arithmetic;
--   · the day the report was printed.
--
-- Not the description. Not the comment. Not the station's name as HDB has it
-- (the station is already public under its own). The editors' view,
-- meganet.station_benchmark, is unchanged and still has all of it.
--
-- Depends on 0101 (bureau_benchmark, benchmark_extract), 0002 (station), 0028
-- (bureau_key), 0031 (station_gauge_survey).

-- ── The mark's number ────────────────────────────────────────────────────────
-- The kinds of mark a description opens with a number: a permanent (PSM), State
-- (SSM) or plain (PM) survey mark, a State datum mark (SD), a Gold Coast City
-- Council mark (CGC), or a numbered benchmark (BM). The same rule as
-- station-benchmarks.js's markName(), which names the mark in a Level Survey:
-- the prefix in capitals, a space after it but for CGC and BM, as the marks
-- are written. Null where there is none — a TBM bolt, a nail in a slab.

create or replace function meganet.benchmark_mark(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
           when m is null then null
           when pg_catalog.upper(m[1]) in ('CGC', 'BM') then pg_catalog.upper(m[1]) || m[2]
           else pg_catalog.upper(m[1]) || ' ' || m[2]
         end
    from (select pg_catalog.regexp_match(coalesce(p, ''),
                   '\y(PSM|SSM|PM|CGC|BM|SD)\s*(?:#\s*)?(\d{3,}[A-Z]?)\y', 'i') as m) x
$$;

comment on function meganet.benchmark_mark(text) is
  'The survey mark''s number a benchmark''s description gives — "PSM 46757", "SD 89025", "CGC200041", "BM6001" — or null (0102). The rule station-benchmarks.js''s markName() follows.';

-- ── The view ─────────────────────────────────────────────────────────────────

create or replace view meganet.station_benchmark_public as
select s.id                 as station_id,
       s.station_number,
       b.bureau_number,
       b.ord,
       meganet.benchmark_mark(b.description) as mark,
       b.level_m,
       b.datum,
       z.gauge_zero_m,
       z.datum              as gauge_datum,
       z.valid_from         as gauge_zero_from,
       case when b.datum in ('AHD', 'STATE') and z.datum = b.datum
            then b.level_m - z.gauge_zero_m end as on_gauge_m,
       x.printed_on
  from meganet.bureau_benchmark b
  join meganet.station s
    on s.deleted_at is null
   and meganet.bureau_key(s.station_number) = meganet.bureau_key(b.bureau_number)
  left join lateral (
        select v.gauge_zero_m, v.datum, v.valid_from
          from meganet.station_gauge_survey v
         where v.station_id = s.id and v.gauge_zero_m is not null
         order by (v.valid_to is null) desc,
                  case when v.valid_to is null then v.valid_from end desc nulls last,
                  v.valid_to desc nulls last,
                  v.ord
         limit 1) z on true
  left join meganet.benchmark_extract x on x.only_row;

comment on view meganet.station_benchmark_public is
  'The Bureau''s benchmarks of each live station in numbers (0102): the mark''s number where its description gives one, its level and datum, the gauge zero in force and on_gauge_m where the datums agree, and the day the report was printed. Published to anybody — deliberately not security_invoker, as 0023''s chart views are not: what it carries is fixed in 0102 and checked there. No description, no comment: those are meganet.station_benchmark''s, for editors.';

-- ── Data API ─────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.station_benchmark_public to anon, authenticated, service_role;
  revoke insert, update, delete, truncate on meganet.station_benchmark_public from anon, authenticated;
  grant execute on function meganet.benchmark_mark(text) to anon, authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take — and is it only the numbers ─────────────────────────────────

do $$
declare
  v_cols text;
begin
  if pg_catalog.to_regclass('meganet.station_benchmark_public') is null then
    raise exception '0102 did not take: meganet.station_benchmark_public is missing';
  end if;
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'meganet.station_benchmark_public'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from
     'station_id,station_number,bureau_number,ord,mark,level_m,datum,gauge_zero_m,gauge_datum,gauge_zero_from,on_gauge_m,printed_on' then
    raise exception '0102 did not take: station_benchmark_public publishes %, not the twelve columns 0102 names', v_cols;
  end if;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid = 'meganet.station_benchmark_public'::regclass
                and 'security_invoker=true' = any (coalesce(c.reloptions, '{}'))) then
    raise exception '0102 did not take: station_benchmark_public is security_invoker, so anon would read nothing';
  end if;
  if meganet.benchmark_mark('PSM # 111818') is distinct from 'PSM 111818'
     or meganet.benchmark_mark('Gold Coast: CGC200042') is distinct from 'CGC200042'
     or meganet.benchmark_mark('Benchmark on causeway BM6001 level 41.78mAHD.') is distinct from 'BM6001'
     or meganet.benchmark_mark('TBM GI nail on kerb adjacent to tower') is not null then
    raise exception '0102 did not take: benchmark_mark() does not read the marks it names';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and not pg_catalog.has_table_privilege('anon', 'meganet.station_benchmark_public', 'select') then
    raise exception '0102 did not take: anon may not read the published benchmarks';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and (pg_catalog.has_table_privilege('anon', 'meganet.bureau_benchmark', 'select')
          or pg_catalog.has_table_privilege('anon', 'meganet.station_benchmark', 'select')) then
    raise exception '0102 did not take: anon may read the editors'' benchmarks, descriptions and all';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 102 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '102')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
