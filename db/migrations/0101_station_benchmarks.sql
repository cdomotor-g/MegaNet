-- 0101_station_benchmarks.sql — The Bureau's benchmarks: the marks each river
-- height station's gauge is levelled from, as HDB holds them — their level,
-- datum, what each is and where — and, through the gauge survey, what each
-- reads on the gauge.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0101_station_benchmarks.sql
--
-- The rows arrive from the private repository, not from this file:
--
--   python3 tools/ingest/benchmarks.py --sql \
--     | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
--
-- Why this file exists
-- ────────────────────
-- A level survey (0060) starts on a benchmark of known level and closes on it,
-- and until now Flood-Net had none to offer: the station lists (0031) give a
-- gauge's zero, never the marks it was levelled from, and station_level_point
-- fills only as administrators adopt surveys. The Bureau's report
-- *Queensland Flood Warning River Height Stations — Benchmark Details*, printed
-- from HDB on 15/10/2026, is the list a crew wants on the bank: 777 benchmarks
-- at 519 stations, each with its level, its datum (AHD 578, assumed 153, State
-- 43, unknown 3), what the mark is and where ("PSM 46757", "TBM bolt in gum
-- 18m and 294deg from corner of pump shed") and the office's comments.
-- tools/ingest/benchmarks.py reads it.
--
-- What is stored, and in what shape
-- ─────────────────────────────────
-- The report as printed, keyed on the bureau number the way the flood peaks
-- are (0037) and for 0037's reasons — it is the Bureau's record rather than
-- something an editor types, and a gauge that is not a Flood-Net station
-- today keeps its marks for the day it is:
--
--   meganet.benchmark_extract  one row: which report, when, and its meta
--   meganet.bureau_benchmark   one row per benchmark, in the order printed
--
-- and one view that puts them on the stations:
--
--   meganet.station_benchmark  every benchmark of a live station, with the
--                              gauge zero in force and the level on the gauge
--
-- The loader makes the table match the document; nothing else writes it.
-- The station document (station_json) does not carry them: that document is
-- anybody's, and these are not.
--
-- On the gauge
-- ────────────
-- `on_gauge_m` is the benchmark's level less the gauge zero in force — the
-- gauge survey row (0031) with no end date and the latest start, else the one
-- that ended last, which is the rule 0037 and the station card use — when the
-- two are in the same datum and that datum is AHD or State. Beaudesert's TBM
-- on the weir is 32.59 m State over a zero of 29.45 m State: 3.14 on the
-- gauge, which is what the description says ("3.147 G.H."). An assumed datum
-- places nothing: an assumed benchmark and an assumed zero need not share an
-- assumption (Rudds Lane's recorder platform is 8.57 "assumed" over an assumed
-- zero of 0.83, and its description says the 8.57 is already on the gauge),
-- and an unknown one is unknown.
--
-- Who reads it
-- ────────────
-- Editors, like the level surveys (0060) and the site features (0061): a
-- benchmark's description and position — a bolt in a tree beside a house, a
-- nail in a gate post near a homestead — are not for the open internet, and
-- nothing here is in the agent API. The report itself lives in the private
-- repository cdomotor-g/flood-net-private for the same reason, and the loader
-- has no fetch-it-from-a-URL road, as the public flood peaks do: the database
-- cannot read a private repository.
--
-- Depends on 0002 (station), 0004 (is_editor, touch_updated_at), 0028
-- (bureau_key), 0031 (station_gauge_survey, gauge_datum).
-- tools/check_station_benchmarks.sql proves it.

-- ── The report ───────────────────────────────────────────────────────────────

create table if not exists meganet.benchmark_extract (
  only_row    boolean     primary key default true,
  title       text        not null,
  -- The day HDB printed it: every page is dated with it.
  printed_on  date,
  -- The file it was read from, in the private repository, and its SHA-256.
  source      text        not null,
  sha256      text,
  -- tools/ingest/benchmarks.py's meta, whole: the counts and the one byte the
  -- export wrote for a dash.
  meta        jsonb       not null default '{}'::jsonb,
  loaded_at   timestamptz not null default now(),
  updated_by  text,
  constraint benchmark_extract_one_row check (only_row)
);

comment on table meganet.benchmark_extract is
  'Which HDB benchmark details report meganet.bureau_benchmark holds: when it was printed, the file it was read from, and the reader''s meta. One row.';

create table if not exists meganet.bureau_benchmark (
  -- As the report prints it: padded to six. Join through meganet.bureau_key().
  bureau_number  text     not null,
  -- The order printed under the station, from 0.
  ord            integer  not null,
  -- The station's name and basin as HDB has them.
  station_name   text     not null,
  basin          text     not null,
  -- The mark's level in metres, in its datum, as printed.
  level_m        numeric  not null,
  datum          text     not null references meganet.gauge_datum (code),
  -- What the mark is and where, and the office's comments — each the report's
  -- wrapped lines joined with a space. Ida Creek's row has no description.
  description    text,
  comment        text,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  primary key (bureau_number, ord),
  constraint bureau_benchmark_number check (bureau_number ~ '^\d+$'),
  constraint bureau_benchmark_ord check (ord >= 0)
);

comment on table meganet.bureau_benchmark is
  'Every benchmark in the HDB benchmark details report (0101), as printed: the station''s bureau number, name and basin, the mark''s level and datum, what it is and where, and the comments. meganet.station_benchmark puts them on Flood-Net stations. Editors only.';
comment on column meganet.bureau_benchmark.level_m is
  'The benchmark''s level in metres, in its datum, as the report prints it (to the centimetre).';

create index if not exists bureau_benchmark_key_idx
  on meganet.bureau_benchmark (meganet.bureau_key(bureau_number));

drop trigger if exists bureau_benchmark_touch_updated_at on meganet.bureau_benchmark;
create trigger bureau_benchmark_touch_updated_at before update on meganet.bureau_benchmark
  for each row execute function meganet.touch_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────
-- Editors read; nobody writes but the loader, which runs as the owner or the
-- service role, neither of which RLS binds.

do $$
declare
  t text;
begin
  foreach t in array array['benchmark_extract', 'bureau_benchmark']
  loop
    execute format('alter table meganet.%I enable row level security', t);
    execute format('drop policy if exists %I on meganet.%I', t || '_read_editors', t);
    execute format('create policy %I on meganet.%I for select to authenticated using (meganet.is_editor())',
                   t || '_read_editors', t);
  end loop;
end
$$;

-- ── On the stations ──────────────────────────────────────────────────────────

create or replace view meganet.station_benchmark
with (security_invoker = true) as
select s.id                 as station_id,
       s.station_number,
       b.bureau_number,
       b.ord,
       b.station_name,
       b.basin,
       b.level_m,
       b.datum,
       b.description,
       b.comment,
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

comment on view meganet.station_benchmark is
  'The HDB benchmarks of each live Flood-Net station (0101), with the gauge zero in force (no end date and the latest start, else the one that ended last) and on_gauge_m — the level less that zero — where both are AHD or both State. security_invoker, so bureau_benchmark''s RLS answers: editors only.';

-- ── Loading ──────────────────────────────────────────────────────────────────
-- Takes the document tools/ingest/benchmarks.py writes and makes the table
-- match it — 0037's contract: upsert everything in the document, delete
-- everything not in it, leave updated_at alone on a row that did not change.

create or replace function meganet.load_benchmarks_doc(doc jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_mark     integer;
  n_number   integer;
  n_station  integer;
  n_on       integer;
  v_bad      text;
begin
  if doc is null or jsonb_typeof(doc -> 'stations') is distinct from 'array' then
    raise exception 'not a benchmarks document: stations[] is missing or is not a list';
  end if;
  -- A benchmark is a list read by position, so a file whose columns moved
  -- would load descriptions as datums. Refused by name instead.
  if (doc -> 'meta' -> 'benchmark_columns')
     is distinct from '["level_m", "datum", "description", "comment"]'::jsonb then
    raise exception 'the document''s benchmarks are not in the columns this reads: %',
      doc -> 'meta' -> 'benchmark_columns';
  end if;
  select string_agg(distinct coalesce(s.value ->> 'bureau_number', '(none)'), ', ') into v_bad
    from jsonb_array_elements(doc -> 'stations') s
   where coalesce(s.value ->> 'bureau_number', '') !~ '^\d+$'
      or coalesce(s.value ->> 'name', '') = ''
      or coalesce(s.value ->> 'basin', '') = ''
      or jsonb_typeof(s.value -> 'benchmarks') is distinct from 'array';
  if v_bad is not null then
    raise exception 'stations this cannot read (a number, a name, a basin and a list of benchmarks each): %', left(v_bad, 200);
  end if;
  -- Twice, or twice under numbers that differ only by leading zeros — which
  -- would be one Flood-Net station with two lists.
  select string_agg(x.n, ', ') into v_bad
    from (select min(s.value ->> 'bureau_number') as n
            from jsonb_array_elements(doc -> 'stations') s
           group by meganet.bureau_key(s.value ->> 'bureau_number')
          having count(*) > 1) x;
  if v_bad is not null then
    raise exception 'a station is in the document twice: %', left(v_bad, 200);
  end if;
  select string_agg(distinct (s.value ->> 'bureau_number') || ' ' || coalesce(e.value::text, ''), '; ') into v_bad
    from jsonb_array_elements(doc -> 'stations') s
   cross join lateral jsonb_array_elements(s.value -> 'benchmarks') e
   where jsonb_typeof(e.value) is distinct from 'array'
      or jsonb_typeof(e.value -> 0) is distinct from 'number'
      or not exists (select 1 from meganet.gauge_datum d where d.code = e.value ->> 1);
  if v_bad is not null then
    raise exception 'benchmarks with no level, or a datum meganet.gauge_datum does not know: %', left(v_bad, 300);
  end if;

  insert into meganet.benchmark_extract (only_row, title, printed_on, source, sha256, meta,
                                         loaded_at, updated_by)
  select true,
         coalesce(doc -> 'meta' ->> 'title', ''),
         (doc -> 'meta' ->> 'printed')::date,
         coalesce(doc -> 'meta' -> 'source' ->> 'file', ''),
         doc -> 'meta' -> 'source' ->> 'sha256',
         coalesce(doc -> 'meta', '{}'::jsonb),
         pg_catalog.now(),
         'load_benchmarks_doc'
  on conflict (only_row) do update
     set title = excluded.title, printed_on = excluded.printed_on,
         source = excluded.source, sha256 = excluded.sha256, meta = excluded.meta,
         loaded_at = excluded.loaded_at, updated_by = excluded.updated_by;

  insert into meganet.bureau_benchmark (
    bureau_number, ord, station_name, basin, level_m, datum, description, comment, updated_by)
  select s.value ->> 'bureau_number',
         (e.ord - 1)::integer,
         s.value ->> 'name',
         s.value ->> 'basin',
         (e.value ->> 0)::numeric,
         e.value ->> 1,
         nullif(e.value ->> 2, ''),
         nullif(e.value ->> 3, ''),
         'load_benchmarks_doc'
    from jsonb_array_elements(doc -> 'stations') s
   cross join lateral jsonb_array_elements(s.value -> 'benchmarks') with ordinality e(value, ord)
  on conflict (bureau_number, ord) do update
     set station_name = excluded.station_name, basin = excluded.basin,
         level_m = excluded.level_m, datum = excluded.datum,
         description = excluded.description, comment = excluded.comment,
         updated_by = excluded.updated_by
   where (meganet.bureau_benchmark.station_name, meganet.bureau_benchmark.basin,
          meganet.bureau_benchmark.level_m, meganet.bureau_benchmark.datum,
          meganet.bureau_benchmark.description, meganet.bureau_benchmark.comment)
      is distinct from (excluded.station_name, excluded.basin, excluded.level_m,
          excluded.datum, excluded.description, excluded.comment);

  -- A station the document no longer lists goes, and a benchmark past the end
  -- of its station's list.
  with listed as (
    select s.value ->> 'bureau_number' as bureau_number,
           jsonb_array_length(s.value -> 'benchmarks') as n
      from jsonb_array_elements(doc -> 'stations') s
  )
  delete from meganet.bureau_benchmark t
   where not exists (select 1 from listed l
                      where l.bureau_number = t.bureau_number and l.n > t.ord);

  select count(*), count(distinct bureau_number) into n_mark, n_number from meganet.bureau_benchmark;
  select count(distinct station_id), count(*) filter (where on_gauge_m is not null)
    into n_station, n_on
    from meganet.station_benchmark;

  return format('loaded %s benchmarks at %s stations, printed %s; %s of those stations are Flood-Net''s, '
                'and %s of the benchmarks have a level on the gauge',
                n_mark, n_number, coalesce(doc -> 'meta' ->> 'printed', 'on an unstated day'),
                n_station, n_on);
end
$$;

revoke all on function meganet.load_benchmarks_doc(jsonb) from public;

comment on function meganet.load_benchmarks_doc(jsonb) is
  'Make meganet.bureau_benchmark match a document from tools/ingest/benchmarks.py. Idempotent: upsert what is in it, delete what is not. The owner''s and the service role''s, nobody else''s.';

-- ── Data API ─────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.benchmark_extract, meganet.bureau_benchmark, meganet.station_benchmark
    from anon;
  revoke insert, update, delete, truncate
      on meganet.benchmark_extract, meganet.bureau_benchmark
    from authenticated;
  -- Said out loud, whatever default privileges a project carries: the loader
  -- replaces the whole table, and is no browser role's to call.
  revoke execute on function meganet.load_benchmarks_doc(jsonb) from anon, authenticated;
  grant select on meganet.benchmark_extract, meganet.bureau_benchmark, meganet.station_benchmark
    to authenticated, service_role;
  grant insert, update, delete on meganet.benchmark_extract, meganet.bureau_benchmark
    to service_role;
  grant execute on function meganet.load_benchmarks_doc(jsonb) to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['benchmark_extract', 'bureau_benchmark'] loop
    if pg_catalog.to_regclass('meganet.' || t) is null then
      raise exception '0101 did not take: meganet.% is missing', t;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('meganet.' || t)) then
      raise exception '0101 did not take: RLS is off on meganet.%', t;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = pg_catalog.to_regclass('meganet.station_benchmark')
                    and 'security_invoker=true' = any (c.reloptions)) then
    raise exception '0101 did not take: meganet.station_benchmark is missing, or reads past RLS';
  end if;
  if pg_catalog.to_regprocedure('meganet.load_benchmarks_doc(jsonb)') is null then
    raise exception '0101 did not take: the loader is missing';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.load_benchmarks_doc(jsonb)', 'execute') then
    raise exception '0101 did not take: public may run the loader';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    if pg_catalog.has_table_privilege('anon', 'meganet.bureau_benchmark', 'select')
       or pg_catalog.has_table_privilege('anon', 'meganet.station_benchmark', 'select') then
      raise exception '0101 did not take: anon may read the benchmarks';
    end if;
    if pg_catalog.has_function_privilege('anon', 'meganet.load_benchmarks_doc(jsonb)', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.load_benchmarks_doc(jsonb)', 'execute') then
      raise exception '0101 did not take: a browser may run the loader';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 101 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '101')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
