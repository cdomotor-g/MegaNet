-- 0038_sls_nsw.sql — The Service Level Specification for New South Wales and
-- the ACT joins Queensland's, and the SLS tables hold one document per state.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0038_sls_nsw.sql
--
-- …and then, once the files are on main, the rows:
--
--   select meganet.load_sls_from_github();
--
-- Why this file exists
-- ────────────────────
-- `archive/NSW_SLS_Current.pdf` is the Bureau's "Service Level Specification
-- for Flood Forecasting and Warning Services for New South Wales and the
-- Australian Capital Territory", version 3.16, December 2025 — byte for byte
-- the file the Bureau publishes at https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf.
-- `tools/ingest/sls.py` reads its six station schedules into data/sls-nsw.json,
-- beside Queensland's data/sls-qld.json. 0028 was written for one document and
-- says so three ways, each of which the second document breaks:
--
--   * meganet.sls_doc is exactly one row. Two editions of two documents are two
--     facts, and "which edition is this row from?" needs an answer per state.
--   * meganet.sls_row is keyed (schedule, bureau number), and 47 bureau numbers
--     are in both documents, all on the Queensland border. They do not
--     agree: GOONDIWINDI's moderate and major levels are 7.5 and 9.2 m in the
--     Queensland document and 6.0 and 8.5 m in the NSW one, its trigger > 7.0
--     and > 6.0. Loaded into 0028's key, one document would overwrite the
--     other's row, and its delete-what-is-not-in-the-document would empty the
--     other document entirely.
--   * meganet.sls_location reads a row's role off Queensland's schedule
--     numbers: `schedule = 7` is Bureau-owned. The NSW document numbers the same
--     six schedules 2, 3a, 4, 6, 7 and 8 — its 6 is Bureau-owned and its 7 is
--     "the Bureau assists", which reads NIL.
--
-- So each document is its own: sls_doc has a row per jurisdiction ('QLD',
-- 'NSW'), sls_row carries the jurisdiction in its key and each row's `role` as
-- the loader read it off its schedule, and sls_location is one row per
-- (jurisdiction, bureau number), its flags read off the role. A station both
-- documents list is two locations. Neither document overrules the other —
-- each is the Bureau's statement of a different state's service — so nothing
-- here merges across them; the station card shows each, headed by its own
-- document.
--
-- A third document is data, not a migration: a jurisdiction, a role per
-- schedule and its rows, through the same loader.
--
-- What the NSW document says that Queensland's does not
-- ─────────────────────────────────────────────────────
-- Five columns, all null (or false) for a Queensland row:
--
--   awrc_number        the gauge's AWRC number, beside every forecast,
--                      information and river data location.
--   gauge_datum        'AHD' or 'Local' — what the gauge's levels are metres
--                      of. "All levels are in metres to Local gauge datums
--                      unless indicated otherwise": where it is AHD, the flood
--                      class levels and the triggers are metres AHD.
--   classes_undefined  the flood classes the page prints "n/a" for: "stations
--                      flood classifications have not yet been defined by the
--                      NSW SES". Not a missing value, a stated one.
--   fast_response      the page's "^": "forecasts are provided for small
--                      catchments with faster response times".
--   interim_service    the page's "*" (WARDELL, BALLINA): "running on an interim
--                      service, while the Bureau develops improved forecasting
--                      tools. There is no determined lead time".
--
-- The merge rule is 0028's, per document: the lowest-numbered schedule that
-- states a field wins, except priority, where the highest stated anywhere
-- wins. NSW's 3a is loaded as schedule 3, which is what the document's own text
-- calls it; sls_doc.schedules keeps the label it prints.

-- ── The documents ────────────────────────────────────────────────────────────
-- 0028's one-row flag gives way to the jurisdiction as the key. The row 0028
-- and 0034 have been describing is Queensland's.

alter table meganet.sls_doc add column if not exists jurisdiction text;
alter table meganet.sls_doc add column if not exists place        text;
alter table meganet.sls_doc add column if not exists published    text;
alter table meganet.sls_doc add column if not exists url          text;
alter table meganet.sls_doc add column if not exists schedules    jsonb;

update meganet.sls_doc set jurisdiction = 'QLD' where jurisdiction is null;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'meganet' and table_name = 'sls_doc'
                and column_name = 'only_row') then
    alter table meganet.sls_doc drop constraint if exists sls_doc_pkey;
    alter table meganet.sls_doc drop column only_row;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'meganet.sls_doc'::regclass and contype = 'p') then
    alter table meganet.sls_doc add constraint sls_doc_pkey primary key (jurisdiction);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'meganet.sls_doc'::regclass
                    and conname = 'sls_doc_jurisdiction_check') then
    alter table meganet.sls_doc add constraint sls_doc_jurisdiction_check
      check (jurisdiction ~ '^[A-Z]{2,3}$');
  end if;
end
$$;

comment on table meganet.sls_doc is
  'Which edition of each state''s Service Level Specification meganet.sls_row was read from: one row per jurisdiction. url is where the Bureau publishes the current edition; archive/ in the MegaNet repository holds the copy the rows were read from.';
comment on column meganet.sls_doc.jurisdiction is
  'The state whose service the document specifies: QLD, or NSW (New South Wales and the Australian Capital Territory).';
comment on column meganet.sls_doc.published is
  'The edition''s month and year, from the document''s own release history — e.g. "December 2025".';
comment on column meganet.sls_doc.url is
  'Where the Bureau publishes the document. Always its current edition, which can be newer than the rows.';
comment on column meganet.sls_doc.schedules is
  'The document''s station schedules, by the number the rows carry: the label it prints ("3a"), title, role, pages, and how many rows it gave (and whether it read NIL).';

-- ── The rows ─────────────────────────────────────────────────────────────────

alter table meganet.sls_row add column if not exists jurisdiction      text not null default 'QLD';
alter table meganet.sls_row add column if not exists role              text;
alter table meganet.sls_row add column if not exists awrc_number       text;
alter table meganet.sls_row add column if not exists gauge_datum       text;
alter table meganet.sls_row add column if not exists classes_undefined text[];
alter table meganet.sls_row add column if not exists fast_response     boolean not null default false;
alter table meganet.sls_row add column if not exists interim_service   boolean not null default false;

-- The default only carried the rows 0028 loaded across. A row that arrives
-- without a jurisdiction from here on is an error, not a Queensland row.
alter table meganet.sls_row alter column jurisdiction drop default;

-- The Queensland rows' roles, from Queensland's numbering — the one place a
-- schedule number is read as a role, and only for rows loaded before the
-- loader said so itself.
update meganet.sls_row
   set role = case schedule
                when 2 then 'forecast_location'   when 3 then 'information_location'
                when 4 then 'river_data_location' when 7 then 'bureau_owned'
                when 8 then 'bureau_assists'      when 9 then 'bureau_colocated'
              end
 where role is null and jurisdiction = 'QLD';

alter table meganet.sls_row alter column role set not null;

do $$
declare
  pk_cols text[];
begin
  select array_agg(a.attname::text order by k.ord)
    into pk_cols
    from pg_catalog.pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'meganet.sls_row'::regclass and c.contype = 'p';
  if pk_cols is distinct from array['jurisdiction', 'schedule', 'bureau_number'] then
    alter table meganet.sls_row drop constraint if exists sls_row_pkey;
    alter table meganet.sls_row add constraint sls_row_pkey
      primary key (jurisdiction, schedule, bureau_number);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'meganet.sls_row'::regclass and conname = 'sls_row_role_check') then
    alter table meganet.sls_row add constraint sls_row_role_check
      check (role in ('forecast_location', 'information_location', 'river_data_location',
                      'bureau_owned', 'bureau_assists', 'bureau_colocated'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'meganet.sls_row'::regclass and conname = 'sls_row_classes_undefined_check') then
    alter table meganet.sls_row add constraint sls_row_classes_undefined_check
      check (classes_undefined <@ array['minor', 'moderate', 'major']::text[]);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'meganet.sls_row'::regclass and conname = 'sls_row_jurisdiction_fkey') then
    alter table meganet.sls_row add constraint sls_row_jurisdiction_fkey
      foreign key (jurisdiction) references meganet.sls_doc (jurisdiction) on delete cascade;
  end if;
end
$$;

-- The touch trigger every table with an updated_at hangs off (0001). 0028 gave
-- sls_row the column and its loader a promise — leave updated_at alone on rows
-- that did not change — but not the trigger, so a row that did change kept the
-- time it was first loaded. With a second document arriving, and editions of
-- both to come, when a row last changed is worth having.
drop trigger if exists sls_row_touch_updated_at on meganet.sls_row;
create trigger sls_row_touch_updated_at before update on meganet.sls_row
  for each row execute function meganet.touch_updated_at();

comment on table meganet.sls_row is
  'One row per (jurisdiction, schedule, bureau number) of a state''s Service Level Specification, as written. The reading of it is meganet.sls_location.';
comment on column meganet.sls_row.bureau_number is
  'Zero-padded to six, as the Queensland document prints it; the NSW one mostly prints it unpadded and the reader pads it, so that one site is one key in every schedule. Join through meganet.bureau_key(), never on equality.';
comment on column meganet.sls_row.schedule is
  'The schedule''s number in its own document. The NSW document''s 3a is 3, which is what its text calls it; sls_doc.schedules keeps the printed label.';
comment on column meganet.sls_row.role is
  'What the schedule is for — forecast_location, information_location, river_data_location, bureau_owned, bureau_assists or bureau_colocated. The documents number their schedules differently; the roles are the same.';
comment on column meganet.sls_row.awrc_number is
  'The gauge''s AWRC number, as the NSW document prints it (some carry a letter, or more than six digits). Null where it prints none, or "n/a": no number allocated.';
comment on column meganet.sls_row.gauge_datum is
  '''AHD'' or ''Local'': what the gauge''s levels are metres of (NSW). Where AHD, the flood class levels and triggers are metres AHD.';
comment on column meganet.sls_row.classes_undefined is
  'The flood classes the page prints "n/a" for — not yet defined by the NSW SES, in the document''s own words. A stated fact, not a missing value.';
comment on column meganet.sls_row.fast_response is
  'The page marks the location "^": a small catchment with a faster response time (NSW).';
comment on column meganet.sls_row.interim_service is
  'The page marks the service "*": an interim service while the Bureau develops improved forecasting tools, with no determined lead time (NSW).';

-- ── The reading of it ────────────────────────────────────────────────────────
-- 0028's view, per document. `create or replace` keeps its grants and its
-- comment's audience, so the columns it had stay where they were and the new
-- ones follow. Flags are read off the role; classes_undefined is an array, so
-- it is the lowest schedule's by a subquery rather than array_agg (which would
-- build a two-dimensional array of them).

create or replace view meganet.sls_location
with (security_invoker = true) as
with merged as (
  select r.jurisdiction,
         r.bureau_number,
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
         bool_or(r.role = 'forecast_location')                                  as forecast_location,
         bool_or(r.role = 'information_location')                               as information_location,
         bool_or(r.role = 'river_data_location')                                as river_data_location,
         bool_or(r.role = 'bureau_owned')                                       as bureau_owned,
         bool_or(r.role = 'bureau_assists')                                     as bureau_assists,
         bool_or(r.role = 'bureau_colocated')                                   as bureau_colocated,
         count(*) > 1                                                           as multi_schedule,
         (array_agg(r.source_note order by r.schedule) filter (where r.source_note is not null))[1] as source_note,
         (array_agg(r.awrc_number    order by r.schedule) filter (where r.awrc_number is not null))[1]    as awrc_number,
         (array_agg(r.gauge_datum    order by r.schedule) filter (where r.gauge_datum is not null))[1]    as gauge_datum,
         (select u.classes_undefined
            from meganet.sls_row u
           where u.jurisdiction = r.jurisdiction and u.bureau_number = r.bureau_number
             and u.classes_undefined is not null
           order by u.schedule
           limit 1)                                                             as classes_undefined,
         bool_or(r.fast_response)                                               as fast_response,
         bool_or(r.interim_service)                                             as interim_service
    from meganet.sls_row r
   group by r.jurisdiction, r.bureau_number
)
select m.bureau_number, m.name, m.owner, m.gauge_type, m.data_type, m.basin_no,
       m.catchment_name, m.class_minor, m.class_moderate, m.class_major,
       m.prediction_type, m.lead_time, m.lead_time_hours, m.trigger_height,
       m.peak_accuracy, m.priority, m.schedules, m.forecast_location,
       m.information_location, m.river_data_location, m.bureau_owned,
       m.bureau_assists, m.bureau_colocated, m.multi_schedule, m.source_note,
       s.id   as station_id,
       s.name as station_name,
       c.id   as catchment_id,
       m.jurisdiction, m.awrc_number, m.gauge_datum, m.classes_undefined,
       m.fast_response, m.interim_service
  from merged m
  left join meganet.station s
         on meganet.bureau_key(s.station_number) = meganet.bureau_key(m.bureau_number)
        and s.deleted_at is null
  -- Lateral, and not a plain join on basin_no, for 0028's reason: basin 144 is
  -- two catchments. Basins 416, 422, 423 and 424 are the Queensland rows'
  -- catchments, and the NSW rows in them find the same one — the same basin,
  -- by its number, whichever document names it.
  left join lateral (
    select cc.id
      from meganet.catchment cc
     where cc.basin_no = m.basin_no
     order by (pg_catalog.lower(cc.name) = pg_catalog.lower(coalesce(m.catchment_name, ''))) desc,
              (pg_catalog.strpos(pg_catalog.lower(coalesce(m.catchment_name, '')),
                                 pg_catalog.lower(cc.name)) > 0) desc,
              cc.ord
     limit 1
  ) c on true;

comment on view meganet.sls_location is
  'One row per (jurisdiction, bureau number): a document''s station schedules merged, joined to meganet.station where the number matches. Lowest schedule wins each field; priority takes the highest stated anywhere. A station both documents list is two rows, one per document — neither overrules the other.';

-- ── Loading ──────────────────────────────────────────────────────────────────
-- 0028's contract, per document: upsert everything in the document, delete
-- everything of *that jurisdiction* not in it, leave updated_at alone on rows
-- that did not change. The other document's rows are not touched.

create or replace function meganet.load_sls_doc(doc jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  j          text := doc -> 'meta' ->> 'jurisdiction';
  bad        text;
  n_row      integer;
  n_loc      integer;
  n_matched  integer;
begin
  if doc is null or jsonb_typeof(doc -> 'schedules') is distinct from 'object' then
    raise exception 'not an SLS document: schedules{} is missing or is not an object';
  end if;
  if j is null or j !~ '^[A-Z]{2,3}$' then
    raise exception 'not an SLS document this schema can file: meta.jurisdiction is %',
      coalesce(pg_catalog.quote_literal(j), 'missing')
      using hint = 'Regenerate it with tools/ingest/sls.py, which says whose document it is.';
  end if;
  select s.key into bad
    from jsonb_each(doc -> 'schedules') s
   where coalesce(s.value ->> 'role', '') not in
         ('forecast_location', 'information_location', 'river_data_location',
          'bureau_owned', 'bureau_assists', 'bureau_colocated')
   limit 1;
  if bad is not null then
    raise exception 'schedule % of the % document has no role this schema knows', bad, j
      using hint = 'Regenerate it with tools/ingest/sls.py, which files each schedule under what it is for.';
  end if;

  insert into meganet.sls_doc (jurisdiction, title, version, source, place, published,
                               url, schedules, loaded_at, updated_by)
  select j,
         coalesce(doc -> 'meta' ->> 'title', ''),
         doc -> 'meta' ->> 'version',
         coalesce(doc -> 'meta' ->> 'source', ''),
         doc -> 'meta' ->> 'place',
         doc -> 'meta' ->> 'published',
         doc -> 'meta' ->> 'url',
         (select jsonb_object_agg(s.key, jsonb_build_object(
                   'label',   coalesce(s.value ->> 'label', s.key),
                   'title',   s.value ->> 'title',
                   'role',    s.value ->> 'role',
                   'pages',   s.value -> 'pages',
                   'rows',    jsonb_array_length(coalesce(s.value -> 'rows', '[]'::jsonb)),
                   'unkeyed', jsonb_array_length(coalesce(s.value -> 'unkeyed', '[]'::jsonb)),
                   'nil',     coalesce((s.value ->> 'nil')::boolean, false)))
            from jsonb_each(doc -> 'schedules') s),
         pg_catalog.now(),
         'load_sls_doc'
  on conflict (jurisdiction) do update
     set title = excluded.title, version = excluded.version,
         source = excluded.source, place = excluded.place,
         published = excluded.published, url = excluded.url,
         schedules = excluded.schedules, loaded_at = excluded.loaded_at,
         updated_by = excluded.updated_by;

  insert into meganet.sls_row (
    jurisdiction, schedule, bureau_number, ord, role, name, owner, gauge_type,
    data_type, priority, basin_no, catchment_name, awrc_number, gauge_datum,
    class_minor, class_moderate, class_major, classes_undefined,
    prediction_type, lead_time, lead_time_hours, trigger_height, peak_accuracy,
    footnoted, fast_response, interim_service, source_note, updated_by)
  select j,
         (sched.key)::integer,
         e.value ->> 'bureau_number',
         (e.ord - 1)::integer,
         sched.value ->> 'role',
         e.value ->> 'name',
         e.value ->> 'owner',
         e.value ->> 'gauge_type',
         e.value ->> 'data_type',
         e.value ->> 'priority',
         e.value ->> 'basin_no',
         e.value ->> 'catchment_name',
         e.value ->> 'awrc_number',
         e.value ->> 'gauge_datum',
         (e.value ->> 'class_minor')::numeric,
         (e.value ->> 'class_moderate')::numeric,
         (e.value ->> 'class_major')::numeric,
         case when jsonb_typeof(e.value -> 'classes_undefined') = 'array'
              then array(select jsonb_array_elements_text(e.value -> 'classes_undefined')) end,
         e.value ->> 'prediction_type',
         e.value ->> 'lead_time',
         (e.value ->> 'lead_time_hours')::numeric,
         e.value ->> 'trigger',
         e.value ->> 'peak_accuracy',
         coalesce((e.value ->> 'footnoted')::boolean, false),
         coalesce((e.value ->> 'fast_response')::boolean, false),
         coalesce((e.value ->> 'interim_service')::boolean, false),
         e.value ->> 'source_note',
         'load_sls_doc'
    from jsonb_each(doc -> 'schedules') sched
    cross join lateral jsonb_array_elements(coalesce(sched.value -> 'rows', '[]'::jsonb))
               with ordinality e(value, ord)
  on conflict (jurisdiction, schedule, bureau_number) do update
     set ord = excluded.ord, role = excluded.role, name = excluded.name,
         owner = excluded.owner, gauge_type = excluded.gauge_type,
         data_type = excluded.data_type, priority = excluded.priority,
         basin_no = excluded.basin_no, catchment_name = excluded.catchment_name,
         awrc_number = excluded.awrc_number, gauge_datum = excluded.gauge_datum,
         class_minor = excluded.class_minor, class_moderate = excluded.class_moderate,
         class_major = excluded.class_major, classes_undefined = excluded.classes_undefined,
         prediction_type = excluded.prediction_type,
         lead_time = excluded.lead_time, lead_time_hours = excluded.lead_time_hours,
         trigger_height = excluded.trigger_height, peak_accuracy = excluded.peak_accuracy,
         footnoted = excluded.footnoted, fast_response = excluded.fast_response,
         interim_service = excluded.interim_service, source_note = excluded.source_note,
         updated_by = excluded.updated_by
   where (meganet.sls_row.ord, meganet.sls_row.role, meganet.sls_row.name,
          meganet.sls_row.owner, meganet.sls_row.gauge_type, meganet.sls_row.data_type,
          meganet.sls_row.priority, meganet.sls_row.basin_no,
          meganet.sls_row.catchment_name, meganet.sls_row.awrc_number,
          meganet.sls_row.gauge_datum, meganet.sls_row.class_minor,
          meganet.sls_row.class_moderate, meganet.sls_row.class_major,
          meganet.sls_row.classes_undefined, meganet.sls_row.prediction_type,
          meganet.sls_row.lead_time, meganet.sls_row.lead_time_hours,
          meganet.sls_row.trigger_height, meganet.sls_row.peak_accuracy,
          meganet.sls_row.footnoted, meganet.sls_row.fast_response,
          meganet.sls_row.interim_service, meganet.sls_row.source_note)
      is distinct from (excluded.ord, excluded.role, excluded.name, excluded.owner,
          excluded.gauge_type, excluded.data_type, excluded.priority,
          excluded.basin_no, excluded.catchment_name, excluded.awrc_number,
          excluded.gauge_datum, excluded.class_minor, excluded.class_moderate,
          excluded.class_major, excluded.classes_undefined, excluded.prediction_type,
          excluded.lead_time, excluded.lead_time_hours, excluded.trigger_height,
          excluded.peak_accuracy, excluded.footnoted, excluded.fast_response,
          excluded.interim_service, excluded.source_note);

  delete from meganet.sls_row t
   where t.jurisdiction = j
     and not exists (
       select 1 from jsonb_each(doc -> 'schedules') sched
         cross join lateral jsonb_array_elements(coalesce(sched.value -> 'rows', '[]'::jsonb)) e
        where (sched.key)::integer = t.schedule
          and e.value ->> 'bureau_number' = t.bureau_number);

  select count(*) into n_row from meganet.sls_row where jurisdiction = j;
  select count(*), count(station_id) into n_loc, n_matched
    from meganet.sls_location where jurisdiction = j;

  return format('loaded %s %s SLS rows; %s of %s locations match a MegaNet station',
                n_row, j, n_matched, n_loc);
end
$$;

revoke all on function meganet.load_sls_doc(jsonb) from public;

comment on function meganet.load_sls_doc(jsonb) is
  'Make meganet.sls_row match one state''s SLS document from tools/ingest/sls.py (meta.jurisdiction says whose). Idempotent: upsert what is in it, delete that jurisdiction''s rows that are not; the other documents'' rows are not touched.';

comment on function meganet.load_sls_from_url(text) is
  'Fetch one SLS document over HTTP and load it. Defaults to data/sls-qld.json on main in the MegaNet repo; meganet.load_sls_from_github() loads every document.';

-- Every document the repository has, in one call — what to run after a new
-- edition of either has been pushed.
create or replace function meganet.load_sls_from_github()
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  f    text;
  said text[] := '{}';
begin
  foreach f in array array['sls-qld.json', 'sls-nsw.json']
  loop
    said := said || meganet.load_sls_from_url(
      'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/data/' || f);
  end loop;
  return pg_catalog.array_to_string(said, E'\n');
end
$$;

revoke all on function meganet.load_sls_from_github() from public;

comment on function meganet.load_sls_from_github() is
  'Load every state''s SLS document — data/sls-qld.json and data/sls-nsw.json — from main in the MegaNet repo.';

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
  grant execute on function meganet.load_sls_doc(jsonb) to service_role;
  grant execute on function meganet.load_sls_from_github() to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'meganet' and table_name = 'sls_doc'
                and column_name = 'only_row') then
    raise exception '0038 did not take: sls_doc still has its one-row flag';
  end if;
  if (select array_agg(a.attname::text order by k.ord)
        from pg_catalog.pg_constraint c
        cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
        join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'meganet.sls_row'::regclass and c.contype = 'p')
     is distinct from array['jurisdiction', 'schedule', 'bureau_number'] then
    raise exception '0038 did not take: sls_row is not keyed (jurisdiction, schedule, bureau_number)';
  end if;
  if exists (select 1 from meganet.sls_row where role is null) then
    raise exception '0038 did not take: % SLS rows have no role',
      (select count(*) from meganet.sls_row where role is null);
  end if;
  if to_regprocedure('meganet.load_sls_from_github()') is null then
    raise exception '0038 did not take: meganet.load_sls_from_github is missing';
  end if;
  if (select count(*) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'meganet' and c.relname in ('sls_row', 'sls_doc')
         and c.relrowsecurity) <> 2 then
    raise exception '0038 did not take: RLS is not enabled on both SLS tables';
  end if;
  -- 0028's guard, per document: one row per (jurisdiction, bureau number) and
  -- no more, rows loaded or not.
  if (select count(*) from meganet.sls_location)
     is distinct from (select count(*) from (select distinct jurisdiction, bureau_number
                                               from meganet.sls_row) d) then
    raise exception '0038 did not take: sls_location has % rows for % (jurisdiction, bureau number) pairs — a join is fanning out',
      (select count(*) from meganet.sls_location),
      (select count(*) from (select distinct jurisdiction, bureau_number from meganet.sls_row) d);
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 37 → 38 in the same commit as this file.
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '38')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
