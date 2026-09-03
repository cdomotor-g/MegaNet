-- 0025_link_fade_margin.sql — Fade margin per radio link, computed in the
-- browser and kept here so nobody has to compute it twice.
--
-- The Stations map draws every pass-range link and every backbone path. Until
-- now it drew all of them the same orange, with one exception: MapLos would
-- paint a line red when the terrain cut its line of sight. That is a useful
-- bit, and it is one bit. What a planner actually reads a network by is the
-- fade margin — how much signal is left over once Longley–Rice has taken its
-- cut — and that is the number this table holds.
--
-- Why it is stored at all, when the app can work it out: because working it out
-- is a terrain profile per link, a few thousand links, and several minutes of
-- tile fetching. MapLos keeps its verdicts in localStorage, which means the
-- second person to open the map pays the whole bill again, and the third pays
-- it after that. A row here is paid for once by whoever pressed Save, and read
-- by everyone after them in one request.
--
-- Three things about the shape, each of which is the same decision made three
-- times in this schema already:
--
--   * The pair is ordered and unique. One line is drawn between two stations,
--     so one row describes it; `station_a_id < station_b_id` is checked rather
--     than assumed, because a table that can hold (A,B) and (B,A) will hold
--     both and then disagree with itself. map-backbone.js's pairKey, in SQL.
--
--   * `margin_db` is the WORSE of the two directions, and both are kept beside
--     it. Path loss is reciprocal; the radios at either end are not. A hop that
--     gets there and cannot answer is not a working link, and a single line on
--     a map can only honestly carry one number.
--
--   * The thresholds travel on the row. `good_db` and `ok_db` are what the
--     colours were judged against when the row was written, and `band` is
--     generated from them — meganet.inspection_rain_gauge's
--     adjustment_threshold_pct exactly, for exactly its reason: a threshold
--     that changes must not silently rewrite what was already judged. The app
--     re-bands on screen from whatever the operator currently has set, which
--     costs nothing; the row records the rule it was saved under.
--
-- And `signature` is the guard that keeps a saved figure from quietly aging
-- into a lie. It carries every input the margin was derived from — both ends'
-- coordinates, elevations, antenna heights, power, gain, line loss and
-- threshold, the frequency, the sample count, the propagation settings and a
-- model version. The app paints a row only while that signature still matches
-- what the station list says today; a moved pin or a retuned repeater makes it
-- stop matching, and the row is counted as stale rather than drawn. Nothing
-- has to remember to invalidate anything.
--
-- Reading is open to anon, because the station document is: the colours are
-- part of what the map looks like, and a map that needs a sign-in to be the
-- right colour is a map with a bug. Writing is editors-only and goes through
-- meganet.save_link_fade, which is the schema's rule for every write.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0025_link_fade_margin.sql

-- ── The table ────────────────────────────────────────────────────────────────

create table if not exists meganet.link_fade_margin (
  station_a_id text not null references meganet.station(id) on delete cascade,
  station_b_id text not null references meganet.station(id) on delete cascade,
  kind         text not null check (kind in ('field', 'backbone')),

  -- dB. numeric, not double precision — db/README.md's rule: a JSON number
  -- round-tripped through a float comes back as 14.499999999999998, and this
  -- one is compared against a threshold for a colour.
  margin_db    numeric not null,
  margin_ab_db numeric,
  margin_ba_db numeric,

  distance_km  numeric,
  freq_mhz     numeric,
  -- The Fresnel verdict the same profile produced — 'clear', 'marginal' or
  -- 'obstructed'. Not what the colour is read from, and kept because a fat
  -- margin over an obstructed path is the one figure worth a second look.
  verdict      text check (verdict is null or verdict in ('clear', 'marginal', 'obstructed')),

  signature    text not null,
  model        text not null,

  good_db      numeric not null default 15,
  ok_db        numeric not null default 6,
  band         text generated always as (
                 case when margin_db >= good_db then 'good'
                      when margin_db >= ok_db   then 'ok'
                      else 'bad' end) stored,

  computed_at  timestamptz not null default now(),
  computed_by  uuid,

  primary key (station_a_id, station_b_id),
  constraint link_fade_margin_pair_ordered check (station_a_id < station_b_id),
  constraint link_fade_margin_bands_ordered check (good_db > ok_db)
);

comment on table meganet.link_fade_margin is
  'Modelled fade margin for one radio link, computed in the browser (Longley-Rice over sampled terrain) and saved so the map can be coloured without recomputing it. One row per station pair, ordered so a link cannot be stored twice.';
comment on column meganet.link_fade_margin.margin_db is
  'dB above the receive threshold, the WORSE of the two directions. Path loss is reciprocal; the radios are not.';
comment on column meganet.link_fade_margin.signature is
  'Every input the margin was derived from, joined. The app paints a row only while this still matches the current station list — which is how a saved figure stops being shown when the network moves under it.';
comment on column meganet.link_fade_margin.good_db is
  'The green threshold this row was judged against. On the row rather than in code, so a later change to the rule does not rewrite what was already saved.';
comment on column meganet.link_fade_margin.band is
  'green/yellow/red as at the moment of saving. Generated, so it cannot disagree with the margin and the thresholds beside it.';

create index if not exists link_fade_margin_band_idx on meganet.link_fade_margin (band);
create index if not exists link_fade_margin_b_idx    on meganet.link_fade_margin (station_b_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Enabled in the same file as the create table, which is this schema's
-- first rule. Read by anyone — the station document is anon-readable and this
-- is a property of the same picture. Written by nobody through the Data API:
-- the RPC below is the only door.

alter table meganet.link_fade_margin enable row level security;

drop policy if exists link_fade_margin_read_all on meganet.link_fade_margin;
create policy link_fade_margin_read_all on meganet.link_fade_margin
  for select using (true);

-- ── The one writer ───────────────────────────────────────────────────────────
-- Upsert, in chunks the app decides the size of. A whole network is a few
-- thousand rows and the client sends them a few hundred at a time, so this is
-- called repeatedly rather than once — which is why it is an upsert on the
-- primary key and not a truncate-and-load. Rows for links that no longer exist
-- are left where they are: they cost nothing, and their signatures will never
-- match again, so nothing will ever paint from them.

create or replace function meganet.save_link_fade(
  p_rows    jsonb,
  p_good_db numeric default 15,
  p_ok_db   numeric default 6)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_written integer;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to save link fade margins' using errcode = '42501';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  if p_good_db is null or p_ok_db is null or p_good_db <= p_ok_db then
    raise exception 'the green threshold must sit above the yellow one' using errcode = '22023';
  end if;

  with incoming as (
    select
      -- Ordered here as well as checked by the constraint, so a client that
      -- sends a pair the other way round is corrected rather than refused.
      least(r.station_a_id, r.station_b_id)    as a_id,
      greatest(r.station_a_id, r.station_b_id) as b_id,
      r.kind, r.margin_db, r.margin_ab_db, r.margin_ba_db,
      r.distance_km, r.freq_mhz, r.verdict, r.signature, r.model
      from pg_catalog.jsonb_to_recordset(p_rows) as r(
        station_a_id text, station_b_id text, kind text,
        margin_db numeric, margin_ab_db numeric, margin_ba_db numeric,
        distance_km numeric, freq_mhz numeric,
        verdict text, signature text, model text)
     where r.station_a_id is not null
       and r.station_b_id is not null
       and r.station_a_id <> r.station_b_id
       and r.margin_db is not null
       and r.signature is not null
  ),
  -- A pair whose stations are not both in the document has no link to describe.
  -- Refusing it here rather than letting the foreign key raise keeps one bad
  -- row from throwing away the other three hundred and ninety-nine in the chunk.
  known as (
    select i.* from incoming i
      join meganet.station sa on sa.id = i.a_id
      join meganet.station sb on sb.id = i.b_id
  ),
  written as (
    insert into meganet.link_fade_margin as t (
      station_a_id, station_b_id, kind, margin_db, margin_ab_db, margin_ba_db,
      distance_km, freq_mhz, verdict, signature, model,
      good_db, ok_db, computed_at, computed_by)
    select k.a_id, k.b_id, coalesce(k.kind, 'field'),
           k.margin_db, k.margin_ab_db, k.margin_ba_db,
           k.distance_km, k.freq_mhz, k.verdict, k.signature, coalesce(k.model, 'unknown'),
           p_good_db, p_ok_db, pg_catalog.now(), auth.uid()
      from known k
    on conflict (station_a_id, station_b_id) do update set
      kind         = excluded.kind,
      margin_db    = excluded.margin_db,
      margin_ab_db = excluded.margin_ab_db,
      margin_ba_db = excluded.margin_ba_db,
      distance_km  = excluded.distance_km,
      freq_mhz     = excluded.freq_mhz,
      verdict      = excluded.verdict,
      signature    = excluded.signature,
      model        = excluded.model,
      good_db      = excluded.good_db,
      ok_db        = excluded.ok_db,
      computed_at  = excluded.computed_at,
      computed_by  = excluded.computed_by
    returning 1)
  select pg_catalog.count(*)::integer into v_written from written;

  return pg_catalog.jsonb_build_object(
    'written', v_written,
    'sent',    pg_catalog.jsonb_array_length(p_rows),
    'good_db', p_good_db,
    'ok_db',   p_ok_db);
end
$$;

comment on function meganet.save_link_fade(jsonb, numeric, numeric) is
  'Upsert a chunk of computed link fade margins, with the thresholds they were judged against. Editors only. Answers how many landed and how many were sent, so a caller can see the pairs it offered that the station document does not have.';

revoke all on function meganet.save_link_fade(jsonb, numeric, numeric) from public;

-- ── Grants — Data API setup, skipped off Supabase ───────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.link_fade_margin to anon, authenticated;
  revoke insert, update, delete on meganet.link_fade_margin from anon, authenticated;
  grant execute on function meganet.save_link_fade(jsonb, numeric, numeric) to authenticated, service_role;
end
$$;

notify pgrst, 'reload schema';

-- ── Did it take ──────────────────────────────────────────────────────────────
-- The storage_bucket.sql lesson (#145): a file that ran says so.

do $$
begin
  if to_regclass('meganet.link_fade_margin') is null then
    raise exception '0025 did not take: meganet.link_fade_margin is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'meganet' and c.relname = 'link_fade_margin' and c.relrowsecurity) then
    raise exception '0025 did not take: RLS is not enabled on meganet.link_fade_margin';
  end if;
  if to_regprocedure('meganet.save_link_fade(jsonb, numeric, numeric)') is null then
    raise exception '0025 did not take: meganet.save_link_fade is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 24 → 25 in the same commit as this file.
-- 0013's note records why that is said here rather than remembered: 0012 bumped
-- the database and missed the app, and the app showed a schema-mismatch banner
-- until #147 found it.

insert into meganet.app_meta (key, value)
values ('schema_version', '25')
on conflict (key) do update set value = excluded.value;
