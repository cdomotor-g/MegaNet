-- 0037_flood_peaks.sql — The floods each gauge has seen: HDB's peak flood
-- heights, every one of them, and on each station the five largest — put in
-- metres AHD through the gauge zero in force on the day, where that can be
-- done honestly.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0037_flood_peaks.sql
--
-- The rows arrive from data/flood-peaks.json, not from this file:
--
--   select meganet.load_flood_peaks_from_url();
--
-- Why this file exists
-- ────────────────────
-- The Digital Twin's flood water (flood-stages.js, roadmap revision 101) has
-- read a `flood_peaks` list on the station since it shipped, and nothing has
-- ever written one: the HDB extract that carries the peaks was failing (#203).
-- It arrived on 28/09/2026 — archive/flood-peaks/all-flood-peaks-2026-09-28.txt,
-- 54 basins, 1,536 gauges, 61,039 peaks after the 276 rows it prints twice —
-- and tools/ingest/flood_peaks.py reads it into data/flood-peaks.json.
--
-- What is stored, and in what shape
-- ─────────────────────────────────
-- The extract as printed, in three tables keyed on the bureau number the way
-- the SLS is (0028) rather than hanging off meganet.station the way the AEP
-- levels do (0033):
--
--   meganet.flood_peak_extract  one row: which extract, when, and its meta
--   meganet.flood_peak_gauge    one row per gauge the extract lists
--   meganet.flood_peak          one row per peak, in the order printed
--
-- Keyed on the number because 170 of the gauges are not MegaNet stations —
-- the DNRM and Seqwater gauges, the manual gauges the network does not carry
-- — and their floods are kept for the day one is (0028's reasoning, and its
-- join: meganet.bureau_key()). And kept apart from the station document's
-- editable lists because they are the Bureau's record, not something an
-- editor types: the loader makes the tables match the file, and nothing else
-- writes them. save_station() and load_stations_doc() are not restated —
-- they read the lists they know by name, so a document carrying
-- `flood_peaks` saves and loads exactly as before, the peaks staying where
-- the loader put them.
--
-- What the station record says, and why only five
-- ───────────────────────────────────────────────
-- The station document carries `flood_peaks`: the station's five largest
-- floods, one per July–June season, largest first —
--
--   "flood_peaks": [
--     { "date": "1974-01-27", "height_m": 20.70, "level_m_ahd": 21.72 }, …
--
-- Five, not the 54,858 the MegaNet stations have between them, because the
-- document is what every page load fetches: every peak would add 2.3 MB to
-- a 4.9 MB document, and the twin and the card want the floods people know a
-- river by, not every freshet since 1887. All of them stay here, in
-- meganet.station_flood_peak, for anything that asks.
--
-- `date` is the day in Queensland (UTC+10) when HDB gives the hour — the
-- extract is in UTC, so the flood Brisbane remembers as the 13th of January
-- is printed on the 12th — and otherwise as much of a date as HDB holds
-- (1947-01, 1887). `height_m` is on the gauge, as printed. `level_m_ahd` is
-- that height put through the gauge zero *in force on that date*, and is
-- absent when it cannot be done honestly — below.
--
-- The zero on the day
-- ───────────────────
-- A peak is a reading of the gauge as it stood then, and 129 of the stations
-- with peaks have had more than one zero. Tinaroo Dam's gauge read AHD
-- straight off a zero of 0 until the last day of 2010, the survey says, and
-- has read off 670.42 m since: its March 1977 flood is printed as 672.63, the
-- level in AHD. Put through today's zero it would stand 670 m in the air. So the
-- zero is the gauge survey row (0031) that started last on or before the
-- peak's date — undated counting as always — and, for a peak older than every
-- row, the oldest row: HDB's 1887 mark at Beenleigh is placed through the
-- zero surveyed in 1998, there being no other. A zero on the assumed, a
-- State or an unknown datum places nothing, as for a flood class.
--
-- And a level that could not be right is not placed
-- ─────────────────────────────────────────────────
-- HDB's record is not consistent about what a height is. Little Nerang Dam
-- lists its 1996 peak twice, once as 1.35 on the gauge and once as 169.38 —
-- the same peak, written in m AHD — and Tinaroo Dam lists most of its floods
-- both ways, 672.67 and 2.33 m over the spillway for February 1999. Gyranda
-- Weir prints 157–160 m from 1988 into the 1990s over a zero of 100.25 m AHD.
-- Put through the zero, some of these are levels 150–170 m above the river
-- and others 670 m below it. So every level is checked against the station's
-- own anchor:
--
--   the major class (else moderate, else minor) through today's zero, when
--   that zero is AHD; else the AEP 1% level (else the rarer ones); else the
--   median of the station's own levels;
--
-- and one more than 20 m above it or 30 m below it is left off the ground,
-- with the reason (`not_placed`). The biggest real floods clear this with
-- room to spare — Ipswich's 1893 peak is 12.9 m over its major class, Mt
-- Crosby's 11 m — and what it catches is almost all storages, whose
-- headwater gauges have changed what they read more often than the survey
-- says. What it cannot catch is a gauge wrong in one piece: Leslie Dam's
-- headwater has classes of 2–3 m on a zero the survey puts at 0 m AHD, where
-- the water is at 470, and the peaks that agree with them are placed as
-- wrongly as they are. The twin, which has the ground, says there that every
-- level is below it rather than drawing water under the hill.
--
-- The five are chosen among the placed peaks when there are any, and among
-- the heights on the gauge when there are none — so a station whose zero is
-- not in AHD still carries its largest floods, as gauge heights, for the
-- card to list and the twin to name.
--
-- Idempotent and forward-only, per db/README.md.

-- ── The extract ──────────────────────────────────────────────────────────────

create table if not exists meganet.flood_peak_extract (
  only_row      boolean     primary key default true,
  title         text        not null,
  -- The day HDB ran it: every basin's page is dated with it.
  extracted_on  date,
  -- The file in this repo it was read from, and its SHA-256.
  source        text        not null,
  sha256        text,
  -- tools/ingest/flood_peaks.py's meta, whole: the counts, the gauges HDB
  -- skipped and the ones it has no peaks for.
  meta          jsonb       not null default '{}'::jsonb,
  loaded_at     timestamptz not null default now(),
  updated_by    text,
  constraint flood_peak_extract_one_row check (only_row)
);

comment on table meganet.flood_peak_extract is
  'Which HDB peak flood heights extract meganet.flood_peak holds: when it was run, the file it was read from, and the reader''s meta. One row.';

create table if not exists meganet.flood_peak_gauge (
  -- As the extract prints it: unpadded, like station_number.
  bureau_number       text        primary key,
  ord                 integer     not null,
  name                text        not null,
  stream              text,
  awrc_number         text,
  basin               text        not null,
  -- The file of the extract this gauge was under — SOUTH_COAST_PEAKS_NEW.TXT.
  source_file         text,
  -- The classifications the extract prints over the gauge's peaks. Usually
  -- Section 4's; kept because they are what HDB held beside these heights.
  minor_m             numeric,
  moderate_m          numeric,
  major_m             numeric,
  -- Rows the extract printed twice, identically, and the reader kept once.
  duplicates_dropped  integer     not null default 0,
  updated_at          timestamptz not null default now(),
  updated_by          text
);

comment on table meganet.flood_peak_gauge is
  'One row per gauge in the HDB peak flood heights extract, MegaNet station or not. Join to meganet.station through meganet.bureau_key(), never on equality.';

-- Two gauges whose numbers differ only by leading zeros would be one station
-- twice; the reader refuses them, and so does this.
create unique index if not exists flood_peak_gauge_key_idx
  on meganet.flood_peak_gauge (meganet.bureau_key(bureau_number));

create table if not exists meganet.flood_peak (
  bureau_number   text     not null references meganet.flood_peak_gauge (bureau_number)
                           on delete cascade,
  -- The order printed under the gauge: the dated rows in date order, then the
  -- ones HDB holds less of a date for.
  ord             integer  not null,
  -- The date in UTC as printed. Where HDB holds only a month or a year it is
  -- the first of the month or the first of January, and date_precision says so.
  peak_date       date     not null,
  date_precision  text     not null,
  time_utc        time,
  -- On the gauge, as the gauge then stood: see "The zero on the day" above.
  height_m        numeric  not null,
  -- The HDB site letter — a gauge that has moved has sites A, B, C…
  site            text,
  -- Where the figure came from, and what kind of reading it is, in HDB's
  -- words: LOG SHEET, DNRM, REGISTER, F521, WRC, CBM CHART, OTHER; and
  -- INSTRUMENT, MANUAL OBS, FLOOD MARK, UNKNOWN.
  obs_source      text,
  obs_type        text,
  primary key (bureau_number, ord),
  constraint flood_peak_precision check (date_precision in ('day', 'month', 'year')),
  constraint flood_peak_partial_date check (
    date_precision = 'day'
    or (date_precision = 'month' and extract(day from peak_date) = 1)
    or (date_precision = 'year' and extract(day from peak_date) = 1
                                and extract(month from peak_date) = 1))
);

comment on table meganet.flood_peak is
  'Every peak in the HDB peak flood heights extract, as printed: the UTC date (to the day, month or year), the time, the height on the gauge as it then stood, the site, the source and the kind of reading. meganet.station_flood_peak puts them on MegaNet stations and in metres AHD.';

-- The touch trigger every table with an updated_at hangs off (0001).
drop trigger if exists flood_peak_gauge_touch_updated_at on meganet.flood_peak_gauge;
create trigger flood_peak_gauge_touch_updated_at before update on meganet.flood_peak_gauge
  for each row execute function meganet.touch_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────
-- Read for everyone, like the SLS and the AEP levels: flood heights are the
-- Bureau's published record and the station card is for anybody. No write
-- policy at all — the loader runs as the service role, which RLS does not
-- bind, and nothing else writes these.

do $$
declare
  t text;
begin
  foreach t in array array['flood_peak_extract', 'flood_peak_gauge', 'flood_peak']
  loop
    execute format('alter table meganet.%I enable row level security', t);
    execute format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute format('create policy %I on meganet.%I for select using (true)',
                   t || '_read_all', t);
  end loop;
end
$$;

-- ── Where each peak stands: meganet.station_flood_peaks() ────────────────────
-- The rules in the header, as one query over the peaks of the stations asked
-- for (all of them when p_station_ids is null): one row per peak of a gauge
-- that is a live MegaNet station, with the zero it stands on, its level in
-- metres AHD where it can be put on the ground, why not where it cannot, and
-- — for the five largest floods — its rank.
--
-- A function rather than only a view because the stations it is asked about
-- are filtered first, before any peak is read: the whole network is ~0.3 s of
-- work locally and three times that live, and a station's own peaks are a
-- millisecond. meganet.station_flood_peak below is this for every station.

create or replace function meganet.station_flood_peaks(p_station_ids text[] default null)
returns table (
  station_id     text,
  bureau_number  text,
  ord            integer,
  peak_date      date,
  date_precision text,
  time_utc       time,
  local_date     date,
  date_text      text,
  height_m       numeric,
  site           text,
  obs_source     text,
  obs_type       text,
  zero_m         numeric,
  zero_datum     text,
  zero_from      date,
  zero_in_force  boolean,
  anchor_m       numeric,
  anchor_from    text,
  level_m_ahd    numeric,
  not_placed     text,
  season         integer,
  flood_rank     integer)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  -- Run with EXECUTE, so that it is planned each time for the stations it is
  -- asked about. Planned once without knowing whether that is one station or
  -- all of them, it guessed one, looped where it should hash, and took six
  -- seconds over the whole network rather than half of one.
  return query execute $q$
  with gauge as (
    select s.id as station_id, g.bureau_number
      from meganet.flood_peak_gauge g
      join meganet.station s
        on meganet.bureau_key(s.station_number) = meganet.bureau_key(g.bureau_number)
     where s.deleted_at is null
       and ($1 is null or s.id = any ($1))
  ),
  -- Each survey row's span of days: from its start (undated: the beginning of
  -- time) to the next row's. Where two rows start the same day, the one still
  -- open — else the one that ran longer, else the first listed — is the one in
  -- force, so it is ordered last and the others' spans come out empty.
  span as (
    select v.station_id, v.gauge_zero_m, v.datum, v.valid_from,
           coalesce(v.valid_from, '-infinity'::date) as span_from,
           lead(coalesce(v.valid_from, '-infinity'::date)) over w as span_to,
           row_number() over w as n
      from meganet.station_gauge_survey v
     where v.gauge_zero_m is not null
       and v.station_id in (select station_id from gauge)
    window w as (partition by v.station_id
                 order by coalesce(v.valid_from, '-infinity'::date), v.valid_to asc nulls last,
                          v.ord desc)
  ),
  -- What a level at this station should be near: the major class (else moderate,
  -- else minor) of its newest classification through the zero in force today,
  -- when that zero is AHD; else its AEP 1% level (else the rarer ones), from the
  -- row the card reads (FloodVelocity.pickRow: newest, then most confident).
  anchor as (
    select st.station_id,
           coalesce(cls.m, aep.m) as anchor_m,
           case when cls.m is not null then 'flood class'
                when aep.m is not null then 'AEP level' end as anchor_from
      from (select distinct station_id from gauge) st
      left join lateral (
        select cz.gauge_zero_m + coalesce(fc.major_m, fc.moderate_m, fc.minor_m) as m
          from (select c.major_m, c.moderate_m, c.minor_m
                  from meganet.station_flood_class c
                 where c.station_id = st.station_id
                   and coalesce(c.major_m, c.moderate_m, c.minor_m) is not null
                 order by c.as_at desc nulls last, c.ord
                 limit 1) fc
         cross join (
                select v.gauge_zero_m, v.datum
                  from meganet.station_gauge_survey v
                 where v.station_id = st.station_id and v.gauge_zero_m is not null
                 order by (v.valid_to is null) desc,
                          case when v.valid_to is null then v.valid_from end desc nulls last,
                          v.valid_to desc nulls last,
                          v.ord
                 limit 1) cz
         where cz.datum = 'AHD'
      ) cls on true
      left join lateral (
        select coalesce(a.aep_1_m, a.aep_0_5_m, a.aep_0_2_m, a.aep_0_066_m) as m
          from meganet.station_aep_level a
         where a.station_id = st.station_id
           and coalesce(a.aep_1_m, a.aep_0_5_m, a.aep_0_2_m, a.aep_0_066_m) is not null
         order by a.as_at desc nulls last, a.confidence desc nulls last, a.ord
         limit 1
      ) aep on true
  ),
  -- Each peak with the zero in force on its day — the span it falls in, or, for a
  -- peak older than every span, the oldest row — and the day it is known by:
  -- Queensland's, where HDB gives the hour.
  peak as (
    select g.station_id, p.bureau_number, p.ord, p.peak_date, p.date_precision, p.time_utc,
           p.height_m, p.site, p.obs_source, p.obs_type,
           case when p.date_precision = 'day' and p.time_utc is not null
                then ((p.peak_date + p.time_utc) at time zone 'UTC'
                                                 at time zone 'Australia/Brisbane')::date
                else p.peak_date end as local_date,
           coalesce(sp.gauge_zero_m, sf.gauge_zero_m) as zero_m,
           coalesce(sp.datum, sf.datum) as zero_datum,
           case when sp.station_id is not null then sp.valid_from else sf.valid_from end as zero_from,
           case when sp.station_id is not null then true
                when sf.station_id is not null then false end as zero_in_force
      from gauge g
      join meganet.flood_peak p on p.bureau_number = g.bureau_number
      left join span sp
        on sp.station_id = g.station_id and p.peak_date >= sp.span_from
       and p.peak_date < coalesce(sp.span_to, 'infinity'::date)
      left join span sf
        on sf.station_id = g.station_id and sf.n = 1 and sp.station_id is null
  ),
  -- …and with neither anchor, the middle of the station's own levels.
  median as (
    select pk.station_id,
           (percentile_cont(0.5) within group (order by pk.zero_m + pk.height_m))::numeric as m
      from peak pk
     where pk.zero_datum = 'AHD'
     group by pk.station_id
  ),
  placed as (
    select pk.*,
           coalesce(a.anchor_m, md.m) as anchor_m,
           case when a.anchor_m is not null then a.anchor_from
                when md.m is not null then 'the median of its own levels' end as anchor_from,
           case
             when pk.zero_m is null then 'the gauge has no surveyed zero'
             when pk.zero_datum is distinct from 'AHD' then 'the gauge zero then was not in AHD'
             when pk.zero_m + pk.height_m > coalesce(a.anchor_m, md.m) + 20
               then 'more than 20 m above this gauge''s flood levels'
             when pk.zero_m + pk.height_m < coalesce(a.anchor_m, md.m) - 30
               then 'more than 30 m below this gauge''s flood levels'
           end as not_placed,
           -- A flood is a season, July to June: the Queensland wet runs December
           -- to April, so February 1893's two peaks are one flood, and December
           -- 2010 and January 2011 are one too.
           extract(year from pk.local_date + interval '6 months')::integer as season
      from peak pk
      left join anchor a on a.station_id = pk.station_id
      left join median md on md.station_id = pk.station_id
  ),
  -- Stations with at least one peak on the ground rank those; the rest rank their
  -- heights on the gauge.
  some_placed as (
    select pl.station_id from placed pl where pl.not_placed is null group by pl.station_id
  ),
  ranked as (
    select x.station_id, x.bureau_number, x.ord,
           row_number() over (partition by x.station_id
                              order by x.measure desc, x.local_date, x.ord) as flood_rank
      from (select c.station_id, c.bureau_number, c.ord, c.local_date, c.measure,
                   row_number() over (partition by c.station_id, c.season
                                      order by c.measure desc, c.local_date, c.ord) as in_season
              from (select pl.station_id, pl.bureau_number, pl.ord, pl.local_date, pl.season,
                           case when pl.not_placed is null then pl.zero_m + pl.height_m
                                else pl.height_m end as measure
                      from placed pl
                      left join some_placed sp on sp.station_id = pl.station_id
                     where pl.not_placed is null or sp.station_id is null) c) x
     where x.in_season = 1
  )
  select pl.station_id, pl.bureau_number, pl.ord,
         pl.peak_date, pl.date_precision, pl.time_utc, pl.local_date,
         case pl.date_precision when 'day'   then to_char(pl.local_date, 'YYYY-MM-DD')
                                when 'month' then to_char(pl.peak_date, 'YYYY-MM')
                                else to_char(pl.peak_date, 'YYYY') end,
         pl.height_m, pl.site, pl.obs_source, pl.obs_type,
         pl.zero_m, pl.zero_datum, pl.zero_from, pl.zero_in_force,
         pl.anchor_m, pl.anchor_from,
         case when pl.not_placed is null then pl.zero_m + pl.height_m end,
         pl.not_placed, pl.season,
         case when r.flood_rank <= 5 then r.flood_rank::integer end
    from placed pl
    left join ranked r
      on r.station_id = pl.station_id and r.bureau_number = pl.bureau_number and r.ord = pl.ord
  $q$ using p_station_ids;
end
$fn$;

comment on function meganet.station_flood_peaks(text[]) is
  'Every HDB peak of the live MegaNet stations named (all when null): the zero in force on its date (the survey row that started last on or before it, else the oldest), its level in m AHD where that zero is AHD and the level is within 20 m above / 30 m below the station''s flood levels, why not otherwise (not_placed), and flood_rank 1–5 for its five largest floods, one per July–June season. The header of 0037_flood_peaks.sql has the reasons.';

create or replace view meganet.station_flood_peak
with (security_invoker = true) as
select * from meganet.station_flood_peaks(null);

comment on view meganet.station_flood_peak is
  'meganet.station_flood_peaks() for every station: every HDB peak of a live MegaNet station, placed in m AHD where it honestly can be, with the five largest floods ranked.';

-- ── The five, kept ───────────────────────────────────────────────────────────
-- What station_json reads. Every page load asks for the whole station document,
-- which takes ~1.6 s live before this file; working the five out for every
-- station on every load would add most of another second. So they are kept
-- here and kept current: the loader rebuilds them all, and the triggers below
-- rebuild a station's own whenever what they are worked out from changes — its
-- gauge survey, its flood classes, its AEP levels, its bureau number, or
-- whether it is deleted. Nothing else writes this table.

create table if not exists meganet.station_flood_peak_top (
  station_id     text     not null references meganet.station (id) on delete cascade,
  flood_rank     integer  not null,
  bureau_number  text     not null,
  ord            integer  not null,
  date_text      text     not null,
  height_m       numeric  not null,
  level_m_ahd    numeric,
  primary key (station_id, flood_rank),
  foreign key (bureau_number, ord) references meganet.flood_peak (bureau_number, ord)
    on delete cascade,
  constraint station_flood_peak_top_rank check (flood_rank between 1 and 5)
);

-- The foreign key is checked from this side on every peak a load deletes —
-- 61,039 of them when an extract replaces another — and without an index each
-- check reads the whole table.
create index if not exists station_flood_peak_top_peak_idx
  on meganet.station_flood_peak_top (bureau_number, ord);

comment on table meganet.station_flood_peak_top is
  'Each station''s five largest floods from meganet.station_flood_peaks(), kept for station_json. Rebuilt by meganet.refresh_station_flood_peaks() — by the loader, and by triggers on the survey, the flood classes, the AEP levels and the station.';

alter table meganet.station_flood_peak_top enable row level security;
drop policy if exists station_flood_peak_top_read_all on meganet.station_flood_peak_top;
create policy station_flood_peak_top_read_all on meganet.station_flood_peak_top
  for select using (true);

create or replace function meganet.refresh_station_flood_peaks(p_station_ids text[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from meganet.station_flood_peak_top t
   where p_station_ids is null or t.station_id = any (p_station_ids);
  insert into meganet.station_flood_peak_top (station_id, flood_rank, bureau_number, ord,
                                              date_text, height_m, level_m_ahd)
  select f.station_id, f.flood_rank, f.bureau_number, f.ord, f.date_text, f.height_m,
         f.level_m_ahd
    from meganet.station_flood_peaks(p_station_ids) f
   where f.flood_rank is not null;
  get diagnostics n = row_count;
  return n;
end
$$;

revoke all on function meganet.refresh_station_flood_peaks(text[]) from public;

comment on function meganet.refresh_station_flood_peaks(text[]) is
  'Rebuild meganet.station_flood_peak_top for the stations named, or for all of them. Returns the rows written.';

-- A survey, flood class or AEP row changed: rebuild the stations whose rows
-- they were. Statement-level, so a bulk load rebuilds each station once per
-- statement rather than once per row, and one trigger per event, because
-- Postgres gives a trigger transition tables for one event only.
create or replace function meganet.flood_peak_inputs_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct n.station_id) into ids from new_rows n;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct o.station_id) into ids from old_rows o;
  else
    select array_agg(distinct x.station_id) into ids
      from (select n.station_id from new_rows n
            union
            select o.station_id from old_rows o) x;
  end if;
  if ids is not null then
    perform meganet.refresh_station_flood_peaks(ids);
  end if;
  return null;
end
$$;

-- A station gained or changed its bureau number, or was deleted or restored.
-- Every save touches the station row, so only those changes rebuild anything.
create or replace function meganet.flood_peak_station_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(n.id) into ids
      from new_rows n
     where n.station_number is not null;
  else
    select array_agg(n.id) into ids
      from new_rows n
      join old_rows o on o.id = n.id
     where n.station_number is distinct from o.station_number
        or n.deleted_at is distinct from o.deleted_at;
  end if;
  if ids is not null then
    perform meganet.refresh_station_flood_peaks(ids);
  end if;
  return null;
end
$$;

revoke all on function meganet.flood_peak_inputs_changed() from public;
revoke all on function meganet.flood_peak_station_changed() from public;

do $$
declare
  t text;
begin
  foreach t in array array['station_gauge_survey', 'station_flood_class', 'station_aep_level']
  loop
    execute format('drop trigger if exists %I on meganet.%I', t || '_flood_peaks_ins', t);
    execute format('drop trigger if exists %I on meganet.%I', t || '_flood_peaks_upd', t);
    execute format('drop trigger if exists %I on meganet.%I', t || '_flood_peaks_del', t);
    execute format(
      'create trigger %I after insert on meganet.%I referencing new table as new_rows
         for each statement execute function meganet.flood_peak_inputs_changed()',
      t || '_flood_peaks_ins', t);
    execute format(
      'create trigger %I after update on meganet.%I
         referencing new table as new_rows old table as old_rows
         for each statement execute function meganet.flood_peak_inputs_changed()',
      t || '_flood_peaks_upd', t);
    execute format(
      'create trigger %I after delete on meganet.%I referencing old table as old_rows
         for each statement execute function meganet.flood_peak_inputs_changed()',
      t || '_flood_peaks_del', t);
  end loop;
end
$$;

drop trigger if exists station_flood_peaks_ins on meganet.station;
drop trigger if exists station_flood_peaks_upd on meganet.station;
create trigger station_flood_peaks_ins after insert on meganet.station
  referencing new table as new_rows
  for each statement execute function meganet.flood_peak_station_changed();
create trigger station_flood_peaks_upd after update on meganet.station
  referencing new table as new_rows old table as old_rows
  for each statement execute function meganet.flood_peak_station_changed();

-- ── meganet.station_json — 0033's view, plus the five largest floods ────────

create or replace view meganet.station_json
with (security_invoker = true) as
with sensor_doc as (
  select station_id,
         jsonb_agg(jsonb_build_object(
           'alert_id',  alert_id,
           'type',      type,
           'sensor_id', sensor_id,
           'device_id', device_id
         )
         || case when alert2_sensor_id is null then '{}'::jsonb
                 else jsonb_build_object('alert2_sensor_id', alert2_sensor_id) end
         order by ord) as doc
    from meganet.sensor
   group by station_id
),
range_doc as (
  select repeater_id,
         coalesce(jsonb_agg(jsonb_build_object('low', lo, 'high', hi) order by ord)
                    filter (where kind = 'pass'), '[]'::jsonb) as passes,
         coalesce(jsonb_agg(jsonb_build_object('low', lo, 'high', hi) order by ord)
                    filter (where kind = 'exclusion'), '[]'::jsonb) as exclusions
    from meganet.pass_range
   group by repeater_id
),
-- The three lists 0031 added, each in its `ord` and each row with its nulls
-- stripped: a row states what the list printed and nothing else, so a flood
-- class with no crops-and-grazing level has no such key rather than a null one.
flood_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',             as_at,
           'first_report_m',    first_report_m,
           'crossing_height_m', crossing_height_m,
           'crossing_type',     crossing_type,
           'minor_m',           minor_m,
           'crops_grazing_m',   crops_grazing_m,
           'moderate_m',        moderate_m,
           'towns_m',           towns_m,
           'major_m',           major_m,
           'note',              note
         )) order by ord) as doc
    from meganet.station_flood_class
   group by station_id
),
crossing_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',         as_at,
           'stream',        stream,
           'name',          name,
           'height_m',      height_m,
           'crossing_type', crossing_type,
           'note',          note
         )) order by ord) as doc
    from meganet.station_crossing
   group by station_id
),
survey_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'valid_from',         valid_from,
           'valid_to',           valid_to,
           'gauge_zero_m',       gauge_zero_m,
           'datum',              datum,
           'amtd_km',            amtd_km,
           'catchment_area_km2', catchment_area_km2,
           'note',               note
         )) order by ord) as doc
    from meganet.station_gauge_survey
   group by station_id
),
-- The two lists 0032 added, 0031's way: in `ord`, nulls stripped.
listing_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'section', section,
           'as_at',   as_at,
           'note',    note
         )) order by ord) as doc
    from meganet.station_bureau_listing
   group by station_id
),
effect_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',    as_at,
           'height_m', height_m,
           'effect',   effect,
           'detail',   detail,
           'note',     note
         )) order by ord) as doc
    from meganet.station_flood_effect
   group by station_id
),
-- The two lists 0033 added, on the same terms as 0031's and 0032's: in `ord`,
-- nulls stripped per row, absent where a station has none.
aep_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',            as_at,
           'source',           source,
           'point_lat',        point_lat,
           'point_lon',        point_lon,
           'ground_m',         ground_m,
           'aep_1_m',          aep_1_m,
           'aep_0_5_m',        aep_0_5_m,
           'aep_0_2_m',        aep_0_2_m,
           'aep_0_066_m',      aep_0_066_m,
           'data_quality',     data_quality,
           'level_difference', level_difference,
           'confidence',       confidence,
           'setting',          setting,
           'slope',            slope,
           'slope_basis',      slope_basis,
           'manning_n',        manning_n,
           'note',             note
         )) order by ord) as doc
    from meganet.station_aep_level
   group by station_id
),
freq_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'rx_mhz',       rx_mhz,
           'tx_mhz',       tx_mhz,
           'label',        label,
           'acma_licence', acma_licence
         )) order by ord) as doc
    from meganet.station_frequency
   group by station_id
),
-- 0037's: the station's five largest floods, largest first, as kept in
-- station_flood_peak_top — station_flood_peaks() decides which five and at
-- what level. The level is absent where the peak cannot be put on the ground,
-- and the row says only what the record does: a date, a height on the gauge,
-- and a level if there is one.
peak_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'date',        date_text,
           'height_m',    height_m,
           'level_m_ahd', level_m_ahd
         )) order by flood_rank) as doc
    from meganet.station_flood_peak_top
   group by station_id
)
select s.id,
       s.ord,
       s.updated_at,
       jsonb_build_object(
         'id',                s.id,
         'name',              s.name,
         'station_number',    s.station_number,
         'lat',               s.lat,
         'lon',               s.lon,
         'elevation_ahd',     s.elevation_ahd,
         'roles',             to_jsonb(s.roles),
         'radio_network_ids', to_jsonb(s.radio_network_ids),
         'catchment_ids',     to_jsonb(s.catchment_ids),
         'alert_ids',         s.alert_ids,
         'satcom',            s.satcom,
         'rm_system_id',      s.rm_system_id,
         'enabled',           s.enabled,
         'notes',             s.notes
       )
       -- Absent rather than null where the height was surveyed, which is the
       -- same shape `site` and `lga` use below: a station that carries no
       -- provenance is one whose elevation_ahd came from a survey, and 840 of
       -- them would otherwise each gain a `"elevation_source": null`.
       || case when s.elevation_source is null then '{}'::jsonb
               else jsonb_build_object('elevation_source', s.elevation_source) end
       -- Absent rather than null where nobody has recorded one, for the same
       -- reason: 3,172 stations would otherwise each gain `"owner": null`.
       || case when s.owner is null then '{}'::jsonb
               else jsonb_build_object('owner', s.owner) end
       -- 0032's three, absent where not recorded: most stations are in none of
       -- the Bureau's lists and would otherwise each carry three nulls.
       || case when s.awrc_number is null then '{}'::jsonb
               else jsonb_build_object('awrc_number', s.awrc_number) end
       || case when s.stream is null then '{}'::jsonb
               else jsonb_build_object('stream', s.stream) end
       || case when s.urbs_label is null then '{}'::jsonb
               else jsonb_build_object('urbs_label', s.urbs_label) end
       || case when s.legacy_unit_id is null then '{}'::jsonb
               else jsonb_build_object('legacy_unit_id', s.legacy_unit_id) end
       || case when s.site is null then '{}'::jsonb
               else jsonb_build_object('site', s.site) end
       || case when sd.doc is null then '{}'::jsonb
               else jsonb_build_object('sensors', sd.doc) end
       || case when s.lga is null then '{}'::jsonb
               else jsonb_build_object('lga', s.lga) end
       || case when s.basin is null then '{}'::jsonb
               else jsonb_build_object('basin', s.basin) end
       || case when s.hub_id is null then '{}'::jsonb
               else jsonb_build_object('hub_id', s.hub_id) end
       || case when s.location_types is null then '{}'::jsonb
               else jsonb_build_object('location_types', to_jsonb(s.location_types)) end
       || case when s.tbrg_bucket_size is null then '{}'::jsonb
               else jsonb_build_object('TBRGbucketSize', s.tbrg_bucket_size) end
       || case when s.inspection_config_key is null then '{}'::jsonb
               else jsonb_build_object('inspection_config_key', s.inspection_config_key) end
       || case when s.alert2_station_id is null then '{}'::jsonb
               else jsonb_build_object('alert2_station_id', s.alert2_station_id) end
       || case when r.station_id is null then '{}'::jsonb
               else jsonb_build_object('repeater',
                      jsonb_build_object(
                        'acma_licence', r.acma_licence,
                        'rx_mhz',       r.rx_mhz,
                        'tx_mhz',       r.tx_mhz,
                        'pass_ranges',  coalesce(rd.passes,     '[]'::jsonb),
                        'exclusions',   coalesce(rd.exclusions, '[]'::jsonb),
                        'notes',        r.notes
                      )
                      || case when r.delay_ms is null then '{}'::jsonb
                              else jsonb_build_object('delay_ms', r.delay_ms) end) end
       -- Absent rather than empty where a station has no rows, like `sensors`:
       -- most stations are in none of the Bureau's lists.
       || case when fd.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_classes', fd.doc) end
       || case when cd.doc is null then '{}'::jsonb
               else jsonb_build_object('crossings', cd.doc) end
       || case when gd.doc is null then '{}'::jsonb
               else jsonb_build_object('gauge_survey', gd.doc) end
       || case when ld.doc is null then '{}'::jsonb
               else jsonb_build_object('bureau_listings', ld.doc) end
       || case when ed.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_effects', ed.doc) end
       -- Absent rather than empty for the same reason: most stations are in
       -- neither AEP sheet, and all but the repeaters and base stations have no
       -- frequency beyond the repeater's own.
       || case when ad.doc is null then '{}'::jsonb
               else jsonb_build_object('aep_levels', ad.doc) end
       || case when qd.doc is null then '{}'::jsonb
               else jsonb_build_object('frequencies', qd.doc) end
       -- Absent where HDB lists no peaks for the station's gauge — most of them.
       || case when pd.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_peaks', pd.doc) end
       as doc
  from meganet.station s
  left join sensor_doc sd on sd.station_id = s.id
  left join meganet.repeater r on r.station_id = s.id
  left join range_doc rd on rd.repeater_id = s.id
  left join flood_doc fd on fd.station_id = s.id
  left join crossing_doc cd on cd.station_id = s.id
  left join survey_doc gd on gd.station_id = s.id
  left join listing_doc ld on ld.station_id = s.id
  left join effect_doc ed on ed.station_id = s.id
  left join aep_doc ad on ad.station_id = s.id
  left join freq_doc qd on qd.station_id = s.id
  left join peak_doc pd on pd.station_id = s.id
 where s.deleted_at is null;

-- ── Loading ──────────────────────────────────────────────────────────────────
-- Takes the document tools/ingest/flood_peaks.py writes and makes the tables
-- match it — 0028's contract: upsert everything in the document, delete
-- everything not in it, leave updated_at alone on a gauge that did not change.

create or replace function meganet.load_flood_peaks_doc(doc jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_gauge    integer;
  n_peak     integer;
  n_station  integer;
  n_placed   integer;
  v_bad      text;
begin
  if doc is null or jsonb_typeof(doc -> 'gauges') is distinct from 'array' then
    raise exception 'not a flood peaks document: gauges[] is missing or is not a list';
  end if;
  -- A peak is a list read by position, so a file whose columns moved would
  -- load heights as dates without complaint. Refused by name instead.
  if (doc -> 'meta' -> 'peak_columns')
     is distinct from '["date", "time_utc", "height_m", "site", "source", "type"]'::jsonb then
    raise exception 'the document''s peaks are not in the columns this reads: %',
      doc -> 'meta' -> 'peak_columns';
  end if;
  select string_agg(distinct x.d, ', ') into v_bad
    from (select e.value ->> 0 as d
            from jsonb_array_elements(doc -> 'gauges') g
           cross join lateral jsonb_array_elements(g.value -> 'peaks') e
           where coalesce(e.value ->> 0, '') !~ '^\d{4}(-\d\d(-\d\d)?)?$') x;
  if v_bad is not null then
    raise exception 'peaks with a date this cannot read: %', left(v_bad, 200);
  end if;

  insert into meganet.flood_peak_extract (only_row, title, extracted_on, source, sha256, meta,
                                          loaded_at, updated_by)
  select true,
         coalesce(doc -> 'meta' ->> 'title', ''),
         (doc -> 'meta' ->> 'extracted')::date,
         coalesce(doc -> 'meta' -> 'source' ->> 'file', ''),
         doc -> 'meta' -> 'source' ->> 'sha256',
         coalesce(doc -> 'meta', '{}'::jsonb),
         pg_catalog.now(),
         'load_flood_peaks_doc'
  on conflict (only_row) do update
     set title = excluded.title, extracted_on = excluded.extracted_on,
         source = excluded.source, sha256 = excluded.sha256, meta = excluded.meta,
         loaded_at = excluded.loaded_at, updated_by = excluded.updated_by;

  insert into meganet.flood_peak_gauge (
    bureau_number, ord, name, stream, awrc_number, basin, source_file,
    minor_m, moderate_m, major_m, duplicates_dropped, updated_by)
  select g.value ->> 'bureau_number',
         (g.ord - 1)::integer,
         g.value ->> 'name',
         g.value ->> 'stream',
         g.value ->> 'awrc_number',
         g.value ->> 'basin',
         g.value ->> 'file',
         (g.value -> 'classes' ->> 'minor_m')::numeric,
         (g.value -> 'classes' ->> 'moderate_m')::numeric,
         (g.value -> 'classes' ->> 'major_m')::numeric,
         coalesce((g.value ->> 'duplicates_dropped')::integer, 0),
         'load_flood_peaks_doc'
    from jsonb_array_elements(doc -> 'gauges') with ordinality g(value, ord)
  on conflict (bureau_number) do update
     set ord = excluded.ord, name = excluded.name, stream = excluded.stream,
         awrc_number = excluded.awrc_number, basin = excluded.basin,
         source_file = excluded.source_file, minor_m = excluded.minor_m,
         moderate_m = excluded.moderate_m, major_m = excluded.major_m,
         duplicates_dropped = excluded.duplicates_dropped, updated_by = excluded.updated_by
   where (meganet.flood_peak_gauge.ord, meganet.flood_peak_gauge.name,
          meganet.flood_peak_gauge.stream, meganet.flood_peak_gauge.awrc_number,
          meganet.flood_peak_gauge.basin, meganet.flood_peak_gauge.source_file,
          meganet.flood_peak_gauge.minor_m, meganet.flood_peak_gauge.moderate_m,
          meganet.flood_peak_gauge.major_m, meganet.flood_peak_gauge.duplicates_dropped)
      is distinct from (excluded.ord, excluded.name, excluded.stream, excluded.awrc_number,
          excluded.basin, excluded.source_file, excluded.minor_m, excluded.moderate_m,
          excluded.major_m, excluded.duplicates_dropped);

  -- A gauge the document no longer lists goes, and its peaks with it.
  with listed as (
    select g.value ->> 'bureau_number' as bureau_number
      from jsonb_array_elements(doc -> 'gauges') g
  )
  delete from meganet.flood_peak_gauge t
   where not exists (select 1 from listed l where l.bureau_number = t.bureau_number);

  insert into meganet.flood_peak (
    bureau_number, ord, peak_date, date_precision, time_utc, height_m, site,
    obs_source, obs_type)
  select g.value ->> 'bureau_number',
         (e.ord - 1)::integer,
         case length(e.value ->> 0)
           when 10 then (e.value ->> 0)::date
           when 7  then ((e.value ->> 0) || '-01')::date
           else         ((e.value ->> 0) || '-01-01')::date end,
         case length(e.value ->> 0) when 10 then 'day' when 7 then 'month' else 'year' end,
         (e.value ->> 1)::time,
         (e.value ->> 2)::numeric,
         e.value ->> 3,
         e.value ->> 4,
         e.value ->> 5
    from jsonb_array_elements(doc -> 'gauges') g
   cross join lateral jsonb_array_elements(g.value -> 'peaks') with ordinality e(value, ord)
  on conflict (bureau_number, ord) do update
     set peak_date = excluded.peak_date, date_precision = excluded.date_precision,
         time_utc = excluded.time_utc, height_m = excluded.height_m, site = excluded.site,
         obs_source = excluded.obs_source, obs_type = excluded.obs_type
   where (meganet.flood_peak.peak_date, meganet.flood_peak.date_precision,
          meganet.flood_peak.time_utc, meganet.flood_peak.height_m, meganet.flood_peak.site,
          meganet.flood_peak.obs_source, meganet.flood_peak.obs_type)
      is distinct from (excluded.peak_date, excluded.date_precision, excluded.time_utc,
          excluded.height_m, excluded.site, excluded.obs_source, excluded.obs_type);

  -- …and a peak past the end of its gauge's list in the new document.
  with listed as (
    select g.value ->> 'bureau_number' as bureau_number,
           jsonb_array_length(g.value -> 'peaks') as n
      from jsonb_array_elements(doc -> 'gauges') g
  )
  delete from meganet.flood_peak t
   where not exists (select 1 from listed l
                      where l.bureau_number = t.bureau_number and l.n > t.ord);

  -- Every station's five, from the peaks as they now are.
  perform meganet.refresh_station_flood_peaks();

  select count(*) into n_gauge from meganet.flood_peak_gauge;
  select count(*) into n_peak from meganet.flood_peak;
  select count(distinct station_id), count(distinct station_id) filter (where level_m_ahd is not null)
    into n_station, n_placed
    from meganet.station_flood_peak_top;

  return format('loaded %s gauges and %s peaks, extracted %s; %s gauges are MegaNet stations, '
                'and %s of those have a peak placed in m AHD',
                n_gauge, n_peak, coalesce(doc -> 'meta' ->> 'extracted', 'on an unstated day'),
                n_station, n_placed);
end
$$;

revoke all on function meganet.load_flood_peaks_doc(jsonb) from public;

comment on function meganet.load_flood_peaks_doc(jsonb) is
  'Make meganet.flood_peak_gauge and meganet.flood_peak match a document from tools/ingest/flood_peaks.py. Idempotent: upsert what is in it, delete what is not.';

-- The fetch-it-yourself road 0003 opened for stations.json and 0028 took for
-- the SLS: 3.7 MB of JSON is not something anybody pastes, and the file is
-- public.

create or replace function meganet.load_flood_peaks_from_url(
         url text default 'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/data/flood-peaks.json')
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  http_schema text;
  http_status integer;
  body        text;
begin
  -- Found by name rather than by signature, exactly as 0003 and 0028 do it.
  select n.nspname into http_schema
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'http_get'
   order by case when n.nspname = 'extensions' then 0 else 1 end
   limit 1;

  if http_schema is null then
    raise exception 'the http extension is not enabled on this database'
      using hint = 'run this once, then try again:  '
                   'create extension if not exists http with schema extensions;';
  end if;

  begin
    execute format('select %I.http_set_curlopt(%L, %L)', http_schema, 'CURLOPT_TIMEOUT', '120');
  exception when others then
    null;
  end;

  execute format('select status, content from %I.http_get(%L)', http_schema, url)
     into http_status, body;

  if http_status is distinct from 200 then
    raise exception 'fetching % returned HTTP %', url, http_status;
  end if;

  return meganet.load_flood_peaks_doc(body::jsonb);
end
$$;

comment on function meganet.load_flood_peaks_from_url(text) is
  'Fetch data/flood-peaks.json over HTTP and load it. Defaults to the copy on main in the MegaNet repo.';

revoke all on function meganet.load_flood_peaks_from_url(text) from public;

-- ── Data API ─────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.flood_peak_extract, meganet.flood_peak_gauge, meganet.flood_peak,
                  meganet.station_flood_peak_top, meganet.station_flood_peak
    to anon, authenticated;
  revoke insert, update, delete, truncate
      on meganet.flood_peak_extract, meganet.flood_peak_gauge, meganet.flood_peak,
         meganet.station_flood_peak_top
    from anon, authenticated;
  grant select, insert, update, delete
     on meganet.flood_peak_extract, meganet.flood_peak_gauge, meganet.flood_peak,
        meganet.station_flood_peak_top
    to service_role;
  grant select on meganet.station_flood_peak to service_role;
  -- The rule reads only what anon can read already, so anybody may ask it.
  grant execute on function meganet.station_flood_peaks(text[]) to anon, authenticated, service_role;
  grant execute on function meganet.refresh_station_flood_peaks(text[]) to service_role;
  grant execute on function meganet.load_flood_peaks_doc(jsonb) to service_role;
  grant execute on function meganet.load_flood_peaks_from_url(text) to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────
-- The storage_bucket.sql lesson (#145): a file that ran says so.

do $$
begin
  if to_regclass('meganet.flood_peak') is null
     or to_regclass('meganet.flood_peak_gauge') is null
     or to_regclass('meganet.flood_peak_extract') is null then
    raise exception '0037 did not take: a flood peak table is missing';
  end if;
  if (select count(*) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'meganet'
         and c.relname in ('flood_peak', 'flood_peak_gauge', 'flood_peak_extract')
         and c.relrowsecurity) <> 3 then
    raise exception '0037 did not take: RLS is not enabled on all three flood peak tables';
  end if;
  if not exists (select 1 from pg_catalog.pg_views
                  where schemaname = 'meganet' and viewname = 'station_flood_peak') then
    raise exception '0037 did not take: meganet.station_flood_peak is missing';
  end if;
  if to_regclass('meganet.station_flood_peak_top') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class c
              where c.oid = 'meganet.station_flood_peak_top'::regclass) then
    raise exception '0037 did not take: the kept five are missing, or have no RLS';
  end if;
  if (select count(*) from pg_catalog.pg_trigger
       where not tgisinternal and tgname like '%\_flood\_peaks\_%'
         and tgrelid in ('meganet.station_gauge_survey'::regclass,
                         'meganet.station_flood_class'::regclass,
                         'meganet.station_aep_level'::regclass,
                         'meganet.station'::regclass)) <> 11 then
    raise exception '0037 did not take: the eleven triggers that keep the five current are not all there';
  end if;
  if not exists (select 1 from pg_catalog.pg_views
                  where schemaname = 'meganet' and viewname = 'station_json'
                    and definition like '%''flood_peaks''%'
                    and definition like '%''aep_levels''%') then
    raise exception '0037 did not take: station_json does not carry flood_peaks beside 0033''s lists';
  end if;
  if to_regprocedure('meganet.load_flood_peaks_doc(jsonb)') is null
     or to_regprocedure('meganet.load_flood_peaks_from_url(text)') is null then
    raise exception '0037 did not take: a loader is missing';
  end if;
end
$$;

-- The five, rebuilt from whatever peaks are loaded — none on a first apply; all
-- of them when this file is applied again after a load — and then held to the
-- rule: the kept rows are exactly the ranked rows, no more and no fewer.
select meganet.refresh_station_flood_peaks();

do $$
begin
  if exists (select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
               from meganet.station_flood_peak_top
             except
             select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
               from meganet.station_flood_peaks() where flood_rank is not null)
     or exists (select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
                  from meganet.station_flood_peaks() where flood_rank is not null
                except
                select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
                  from meganet.station_flood_peak_top) then
    raise exception '0037 did not take: the kept five are not the ranked five';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 36 → 37 in the same commit as this file.
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '37')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
