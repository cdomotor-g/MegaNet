-- 0028_sls_schedules.sql — what the Bureau's Service Level Specification says
-- about each station, and the manual gauges MegaNet has never known about.
--
-- Why this file exists
-- ────────────────────
-- `archive/QLD_SLS_current.pdf` is the "Service Level Specification for Flood
-- Forecasting and Warning Services for Queensland", version 3.1, September 2018.
-- Eleven schedules, six of which are tables of stations keyed on the **bureau
-- number** — the same number `meganet.station.station_number` has carried since
-- 0002 and which 0020 made a station's MQTT identity.
--
-- That key makes it the answer to a set of questions this database has never
-- been able to ask about a station:
--
--   * What are its flood class levels — the minor, moderate and major heights
--     that decide which warning goes out?
--   * Does anybody *forecast* for it (Schedule 2), or is it reported and
--     classified but not predicted (Schedule 3)?
--   * If it is forecast, how — quantitatively (a height and a time) or
--     qualitatively (a class) — and with how much warning?
--   * Who owns it, and does the Bureau own it, help maintain it, or merely
--     hang equipment on somebody else's site (Schedules 7, 8, 9)?
--   * Does a person read it, or a radio? 1,187 of these gauges are read by a
--     human being.
--   * How much does it matter when it stops?
--
-- What is stored, and in what shape
-- ─────────────────────────────────
-- Two objects, and the split is the same one 0014 made for the inspection
-- workbook: **the document as written, and the reading of it.**
--
--   meganet.sls_row       One row per (schedule, bureau number), exactly as
--                         `tools/ingest/sls.py` read it off the page. Faithful,
--                         including where the document contradicts itself.
--   meganet.sls_location  A view: one row per bureau number, the six schedules
--                         merged, joined to meganet.station where we have one.
--
-- That matters because the document does contradict itself. 764 bureau numbers
-- appear in more than one schedule, and for 42 of them the priority differs, for
-- 39 the name, for 23 the owner, for 11 the basin, and for one the gauge type.
-- A single merged table would have to pick, and the picking would be
-- unreviewable. Here the rows keep every version and the view states its rule.
--
-- The merge rule, and why
-- ───────────────────────
-- **The lowest-numbered schedule that states a field wins** — because the
-- schedules run from the most specific statement of service to the most general
-- inventory. Schedule 2 is a considered description of a forecast location;
-- Schedule 7 is a list of what the Bureau owns. When they disagree about a name
-- or an owner, the earlier one is the one making a claim about the flood-warning
-- service rather than about a site register.
--
-- **Except priority, where the highest anywhere wins.** Priority measures the
-- impact of losing a site, and a site that is High to any part of the service is
-- High to lose. Taking the lowest schedule's answer would let a "Low" in a site
-- register quietly overrule a "High" in the forecast schedule, which is the one
-- direction this field must never move.
--
-- Every version survives in meganet.sls_row either way.
--
-- The join, and the leading zeros
-- ───────────────────────────────
-- The document writes bureau numbers zero-padded to six — `040846`, `031170`.
-- `station.station_number` does not: 2,167 stations carry six digits, 902 carry
-- five and 87 carry four, and none of them are padded. Matching the strings as
-- they stand finds 884 stations. Matching them with the leading zeros stripped
-- finds **1,146**, and no two numbers on either side collide once stripped. That
-- is `meganet.bureau_key()`, and the 262 stations it recovers are the whole
-- reason it exists rather than a plain equality.
--
-- What the join does and does not cover
-- ─────────────────────────────────────
-- 1,146 of the SLS's 2,783 locations are MegaNet stations. The 1,637 that are
-- not are **kept anyway**, with a null station_id, and this is a deliberate
-- decision rather than an oversight:
--
--   * 855 are manual gauges — 801 of them the Bureau's own — read by an observer
--     and telemetering nothing. MegaNet is a telemetry network and has never had
--     a row for one. They are real flood-warning locations all the same, and
--     "there is a manual river gauge at X and its major level is 8.0 m" is worth
--     being able to answer.
--   * 782 are automatic gauges owned by agencies whose telemetry this network
--     does not carry — DNRME (395), Sunwater, Seqwater, QLD Rail, NSW Office of
--     Water.
--
-- Neither group goes into `stations.json`. They are not MegaNet stations and
-- inventing rows for them would corrupt every count in the app. They live here,
-- reachable, clearly marked, and joined to a station only where one exists.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0028_sls_schedules.sql
--
-- The rows arrive from the extracted JSON, not from this file:
--
--   select meganet.load_sls_from_github();

-- ── The bureau number, as a key ──────────────────────────────────────────────
-- Immutable so it can be indexed. `nullif` so that a station with no number
-- (18 of them — radars, repeaters and test rigs) is null rather than an empty
-- string that would happily equal another empty string.

create or replace function meganet.bureau_key(n text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$ select nullif(pg_catalog.ltrim(pg_catalog.btrim(coalesce(n, '')), '0'), '') $$;

comment on function meganet.bureau_key(text) is
  'A bureau number with its leading zeros and spaces gone, for joining the SLS (which pads to six) to station_number (which does not).';

revoke all on function meganet.bureau_key(text) from public;

create index if not exists station_bureau_key_idx
  on meganet.station (meganet.bureau_key(station_number));

-- ── Provenance ───────────────────────────────────────────────────────────────
-- Which edition of the document these rows came out of. One row, enforced, the
-- same shape and for the same reason as meganet.doc_meta: a schedule read from
-- version 3.1 and a schedule read from a later one are different facts, and the
-- day somebody re-ingests, the question "which one is this?" has to have an
-- answer that is not a git log.

create table if not exists meganet.sls_doc (
  only_row    boolean     primary key default true check (only_row),
  title       text        not null default '',
  version     text,
  source      text        not null default '',
  loaded_at   timestamptz not null default now(),
  updated_by  text
);

comment on table meganet.sls_doc is
  'Which edition of the Queensland Service Level Specification meganet.sls_row was read from. Exactly one row.';

-- ── The document as written ──────────────────────────────────────────────────
-- One row per (schedule, bureau number). Nullable almost throughout, because a
-- schedule states what it states: Schedule 7 has no owner column (the Bureau
-- owns all of it), Schedules 4 and 7-9 have no flood classes, and only Schedule
-- 2 carries a prediction type or a lead time.
--
-- numeric rather than double precision for the flood classes, for 0002's reason:
-- these came out of a document as decimal literals and a float would hand back
-- 6.099999999999999 for a level somebody has to read off a gauge board.

create table if not exists meganet.sls_row (
  schedule         integer     not null,
  bureau_number    text        not null,
  ord              integer     not null,
  name             text,
  owner            text,
  -- 'Manual' or 'Automatic'. The document's own words, not a boolean: a third
  -- value in a later edition should arrive as data rather than as a migration.
  gauge_type       text,
  data_type        text,
  priority         text,
  basin_no         text,
  catchment_name   text,
  class_minor      numeric,
  class_moderate   numeric,
  class_major      numeric,
  prediction_type  text,
  lead_time        text,
  lead_time_hours  numeric,
  trigger_height   text,
  peak_accuracy    text,
  -- The page carried a footnote marker against this row's name.
  footnoted        boolean     not null default false,
  -- Where the document is internally inconsistent and the extractor could not
  -- silently repair it. Two rows carry one: 031170 KAMERUNGA, whose priority
  -- column reads "River", and 035283 whose data type reads "River/River".
  source_note      text,
  updated_at       timestamptz not null default now(),
  updated_by       text,
  primary key (schedule, bureau_number)
);

comment on table meganet.sls_row is
  'One row per (schedule, bureau number) of the Queensland SLS, as written. The reading of it is meganet.sls_location.';
comment on column meganet.sls_row.bureau_number is
  'As the document writes it — zero-padded to six. Join through meganet.bureau_key(), never on equality.';
comment on column meganet.sls_row.priority is
  'The impact of losing this site, per the schedule this row came from. Schedules disagree for 42 numbers; meganet.sls_location takes the highest.';

create index if not exists sls_row_bureau_idx on meganet.sls_row (bureau_number);
create index if not exists sls_row_key_idx    on meganet.sls_row (meganet.bureau_key(bureau_number));
create index if not exists sls_row_basin_idx  on meganet.sls_row (basin_no);

-- ── Row level security ───────────────────────────────────────────────────────
-- Both tables, in the file that creates them. db/README.md is absolute about
-- this: Supabase's rls_auto_enable event trigger covers `public` only, and
-- nothing catches a missing policy in `meganet` for us.
--
-- Read for everyone. This is a published Commonwealth document; a policy handing
-- it to a stranger gives away nothing that the Bureau's own website does not.

do $$
declare
  t text;
begin
  foreach t in array array['sls_doc', 'sls_row']
  loop
    execute format('alter table meganet.%I enable row level security', t);
    execute format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute format('create policy %I on meganet.%I for select using (true)',
                   t || '_read_all', t);
  end loop;
end
$$;

-- ── The reading of it ────────────────────────────────────────────────────────
-- One row per bureau number, six schedules merged, joined to the station where
-- there is one. The rule is in the header: lowest schedule wins every field
-- except priority, where the highest wins.
--
-- `(array_agg(x order by schedule) filter (where x is not null))[1]` is
-- "the lowest-numbered schedule that said anything". It reads oddly and it is
-- exactly the rule, in one expression, per column.
--
-- security_invoker for 0002's reason: without it the view runs as its owner and
-- reads past the RLS policies above. Every base table here is world-readable so
-- the result is the same today — and the day one of them is not, the difference
-- is a data leak.

create or replace view meganet.sls_location
with (security_invoker = true) as
with merged as (
  select r.bureau_number,
         (array_agg(r.name           order by r.schedule) filter (where r.name is not null))[1]           as name,
         (array_agg(r.owner          order by r.schedule) filter (where r.owner is not null))[1]          as owner,
         (array_agg(r.gauge_type     order by r.schedule) filter (where r.gauge_type is not null))[1]     as gauge_type,
         (array_agg(r.data_type      order by r.schedule) filter (where r.data_type is not null))[1]      as data_type,
         (array_agg(r.basin_no       order by r.schedule) filter (where r.basin_no is not null))[1]       as basin_no,
         (array_agg(r.catchment_name order by r.schedule) filter (where r.catchment_name is not null))[1] as catchment_name,
         (array_agg(r.class_minor    order by r.schedule) filter (where r.class_minor is not null))[1]    as class_minor,
         (array_agg(r.class_moderate order by r.schedule) filter (where r.class_moderate is not null))[1] as class_moderate,
         (array_agg(r.class_major    order by r.schedule) filter (where r.class_major is not null))[1]    as class_major,
         (array_agg(r.prediction_type order by r.schedule) filter (where r.prediction_type is not null))[1] as prediction_type,
         (array_agg(r.lead_time      order by r.schedule) filter (where r.lead_time is not null))[1]      as lead_time,
         (array_agg(r.lead_time_hours order by r.schedule) filter (where r.lead_time_hours is not null))[1] as lead_time_hours,
         (array_agg(r.trigger_height order by r.schedule) filter (where r.trigger_height is not null))[1] as trigger_height,
         (array_agg(r.peak_accuracy  order by r.schedule) filter (where r.peak_accuracy is not null))[1]  as peak_accuracy,
         -- The exception. High beats Medium beats Low, wherever it was said.
         case max(case r.priority when 'High' then 3 when 'Medium' then 2
                                  when 'Low' then 1 else null end)
              when 3 then 'High' when 2 then 'Medium' when 1 then 'Low' end     as priority,
         array_agg(distinct r.schedule order by r.schedule)                     as schedules,
         bool_or(r.schedule = 2)                                                as forecast_location,
         bool_or(r.schedule = 3)                                                as information_location,
         bool_or(r.schedule = 4)                                                as river_data_location,
         bool_or(r.schedule = 7)                                                as bureau_owned,
         bool_or(r.schedule = 8)                                                as bureau_assists,
         bool_or(r.schedule = 9)                                                as bureau_colocated,
         count(*) > 1                                                           as multi_schedule,
         (array_agg(r.source_note order by r.schedule) filter (where r.source_note is not null))[1] as source_note
    from meganet.sls_row r
   group by r.bureau_number
)
select m.*,
       s.id   as station_id,
       s.name as station_name,
       c.id   as catchment_id
  from merged m
  left join meganet.station s
         on meganet.bureau_key(s.station_number) = meganet.bureau_key(m.bureau_number)
        and s.deleted_at is null
  left join meganet.catchment c
         on c.basin_no = m.basin_no;

comment on view meganet.sls_location is
  'One row per bureau number: the six SLS station schedules merged, joined to meganet.station where the number matches. Lowest schedule wins each field; priority takes the highest stated anywhere.';

-- ── Loading ──────────────────────────────────────────────────────────────────
-- Takes the document tools/ingest/sls.py writes and makes the table match it.
-- Same contract as load_stations_doc(): upsert everything in the document,
-- delete everything not in it, leave updated_at alone on rows that did not
-- change.

create or replace function meganet.load_sls_doc(doc jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_row      integer;
  n_matched  integer;
begin
  if doc is null or jsonb_typeof(doc -> 'schedules') is distinct from 'object' then
    raise exception 'not an SLS document: schedules{} is missing or is not an object';
  end if;

  insert into meganet.sls_doc (only_row, title, version, source, loaded_at, updated_by)
  select true,
         coalesce(doc -> 'meta' ->> 'title', ''),
         doc -> 'meta' ->> 'version',
         coalesce(doc -> 'meta' ->> 'source', ''),
         pg_catalog.now(),
         'load_sls_doc'
  on conflict (only_row) do update
     set title = excluded.title, version = excluded.version,
         source = excluded.source, loaded_at = excluded.loaded_at,
         updated_by = excluded.updated_by;

  insert into meganet.sls_row (
    schedule, bureau_number, ord, name, owner, gauge_type, data_type, priority,
    basin_no, catchment_name, class_minor, class_moderate, class_major,
    prediction_type, lead_time, lead_time_hours, trigger_height, peak_accuracy,
    footnoted, source_note, updated_by)
  select (sched.key)::integer,
         e.value ->> 'bureau_number',
         (e.ord - 1)::integer,
         e.value ->> 'name',
         e.value ->> 'owner',
         e.value ->> 'gauge_type',
         e.value ->> 'data_type',
         e.value ->> 'priority',
         e.value ->> 'basin_no',
         e.value ->> 'catchment_name',
         (e.value ->> 'class_minor')::numeric,
         (e.value ->> 'class_moderate')::numeric,
         (e.value ->> 'class_major')::numeric,
         e.value ->> 'prediction_type',
         e.value ->> 'lead_time',
         (e.value ->> 'lead_time_hours')::numeric,
         e.value ->> 'trigger',
         e.value ->> 'peak_accuracy',
         coalesce((e.value ->> 'footnoted')::boolean, false),
         e.value ->> 'source_note',
         'load_sls_doc'
    from jsonb_each(doc -> 'schedules') sched
    cross join lateral jsonb_array_elements(sched.value -> 'rows')
               with ordinality e(value, ord)
  on conflict (schedule, bureau_number) do update
     set ord = excluded.ord, name = excluded.name, owner = excluded.owner,
         gauge_type = excluded.gauge_type, data_type = excluded.data_type,
         priority = excluded.priority, basin_no = excluded.basin_no,
         catchment_name = excluded.catchment_name,
         class_minor = excluded.class_minor, class_moderate = excluded.class_moderate,
         class_major = excluded.class_major, prediction_type = excluded.prediction_type,
         lead_time = excluded.lead_time, lead_time_hours = excluded.lead_time_hours,
         trigger_height = excluded.trigger_height, peak_accuracy = excluded.peak_accuracy,
         footnoted = excluded.footnoted, source_note = excluded.source_note,
         updated_by = excluded.updated_by
   where (meganet.sls_row.ord, meganet.sls_row.name, meganet.sls_row.owner,
          meganet.sls_row.gauge_type, meganet.sls_row.data_type,
          meganet.sls_row.priority, meganet.sls_row.basin_no,
          meganet.sls_row.catchment_name, meganet.sls_row.class_minor,
          meganet.sls_row.class_moderate, meganet.sls_row.class_major,
          meganet.sls_row.prediction_type, meganet.sls_row.lead_time,
          meganet.sls_row.lead_time_hours, meganet.sls_row.trigger_height,
          meganet.sls_row.peak_accuracy, meganet.sls_row.footnoted,
          meganet.sls_row.source_note)
      is distinct from (excluded.ord, excluded.name, excluded.owner,
          excluded.gauge_type, excluded.data_type, excluded.priority,
          excluded.basin_no, excluded.catchment_name, excluded.class_minor,
          excluded.class_moderate, excluded.class_major, excluded.prediction_type,
          excluded.lead_time, excluded.lead_time_hours, excluded.trigger_height,
          excluded.peak_accuracy, excluded.footnoted, excluded.source_note);

  delete from meganet.sls_row t
   where not exists (
     select 1 from jsonb_each(doc -> 'schedules') sched
       cross join lateral jsonb_array_elements(sched.value -> 'rows') e
      where (sched.key)::integer = t.schedule
        and e.value ->> 'bureau_number' = t.bureau_number);

  select count(*) into n_row from meganet.sls_row;
  select count(*) into n_matched from meganet.sls_location where station_id is not null;

  return format('loaded %s SLS rows; %s of %s locations match a MegaNet station',
                n_row,
                n_matched,
                (select count(*) from meganet.sls_location));
end
$$;

revoke all on function meganet.load_sls_doc(jsonb) from public;

comment on function meganet.load_sls_doc(jsonb) is
  'Make meganet.sls_row match an SLS document from tools/ingest/sls.py. Idempotent: upsert what is in it, delete what is not.';

-- The same fetch-it-yourself road 0003 opened for stations.json, and for the
-- same reason: 780 KB of JSON is not something anybody pastes into a browser
-- textarea, and the file is public.

create or replace function meganet.load_sls_from_url(
         url text default 'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/data/sls-qld.json')
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  body text;
begin
  if to_regprocedure('extensions.http_get(text)') is null
     and to_regprocedure('public.http_get(text)') is null then
    raise exception 'the http extension is not installed — % cannot be fetched from inside the database', url
      using hint = 'create extension http with schema extensions; or pass the document to meganet.load_sls_doc() instead';
  end if;
  execute 'select content from ' ||
          case when to_regprocedure('extensions.http_get(text)') is not null
               then 'extensions.http_get($1)' else 'public.http_get($1)' end
    into body using url;
  return meganet.load_sls_doc(body::jsonb);
end
$$;

revoke all on function meganet.load_sls_from_url(text) from public;

-- ── Data API ─────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.sls_doc, meganet.sls_row, meganet.sls_location
    to anon, authenticated;
  revoke insert, update, delete on meganet.sls_doc, meganet.sls_row
    from anon, authenticated;
  grant select, insert, update, delete on meganet.sls_doc, meganet.sls_row
    to service_role;
  grant execute on function meganet.bureau_key(text) to anon, authenticated, service_role;
  grant execute on function meganet.load_sls_doc(jsonb) to service_role;
  grant execute on function meganet.load_sls_from_url(text) to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────
-- The storage_bucket.sql lesson (#145): a file that ran says so.

do $$
begin
  if to_regclass('meganet.sls_row') is null then
    raise exception '0028 did not take: meganet.sls_row is missing';
  end if;
  if to_regclass('meganet.sls_doc') is null then
    raise exception '0028 did not take: meganet.sls_doc is missing';
  end if;
  if (select count(*) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'meganet' and c.relname in ('sls_row', 'sls_doc')
         and c.relrowsecurity) <> 2 then
    raise exception '0028 did not take: RLS is not enabled on both SLS tables';
  end if;
  if to_regprocedure('meganet.bureau_key(text)') is null then
    raise exception '0028 did not take: meganet.bureau_key is missing';
  end if;
  if meganet.bureau_key('040846') is distinct from '40846'
     or meganet.bureau_key('540318') is distinct from '540318'
     or meganet.bureau_key('') is not null then
    raise exception '0028 did not take: bureau_key does not strip leading zeros correctly';
  end if;
  if not exists (select 1 from pg_catalog.pg_views
                  where schemaname = 'meganet' and viewname = 'sls_location') then
    raise exception '0028 did not take: meganet.sls_location is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 27 → 28 in the same commit as this file.
-- 0013's note records why that is said here rather than remembered: 0012 bumped
-- the database and missed the app, and the app showed a schema-mismatch banner
-- until #147 found it.

insert into meganet.app_meta (key, value)
values ('schema_version', '28')
on conflict (key) do update set value = excluded.value;
