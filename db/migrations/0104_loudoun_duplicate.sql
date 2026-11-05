-- 0104_loudoun_duplicate.sql — Loudoun Br AL was in the register twice; the
-- copy is retired, and the station and the hand-read gauge beside the copy's
-- position carry a note about where they stand.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0104_loudoun_duplicate.sql
--
-- Why this file exists
-- ────────────────────
-- The owner, looking at the Stations map at Loudoun Bridge on 5 November 2026,
-- saw two stations where there is one. There were two records of Loudoun Br AL:
--
--   loudoun_br_al     541155, AWRC 422988, ALERT 6128–6130, legacy unit 1 —
--                     with the Bureau's listings, flood classes, crossing,
--                     flood effects, AEP levels and peaks hanging off it.
--   loudoun_br_al_2   no station number, the same ALERT addresses, the same
--                     four sensors under the same sensor ids (541155.0.*), the
--                     same Bureau site (db_id 3318), legacy unit 582, and
--                     nothing else attached — no photos, inspections, tasks,
--                     surveys, equipment or history beyond the load.
--
-- One station, filed twice by the station-document load. The copy is retired
-- the way the app's Delete does it (meganet.delete_station): deleted_at is
-- stamped and every row is kept, so meganet.restore_station() brings it back
-- if this was wrong. station_change records it ('deleted', by this file).
--
-- Which position is kept. The copy stood at −27.2136, 151.1858, on top of the
-- hand-read gauge Loudoun Bridge (41339), which is where the Bureau's 2024
-- station list puts that gauge: satellite imagery shows the spot about 1.3 km
-- north of the Condamine, not at the river. The record kept stands at
-- −27.225, 151.185556, beside the river at Loudoun Bridge, where the same list
-- put it on 23 October 2026, 18 m from the state's river gauge 422333A
-- (data/fldwarn-2024/review.json) — before which it sat 28.5 km west, at the
-- Loudoun Bridge Alert (Decoupled RG) rain gauge's position. That move is what the nightly
-- fade-margin re-sweep reported. The owner: leave the position for now, and
-- put a note against the station. Neither position has been confirmed on site.
--
-- A note is written only where the station has none, so a note somebody has
-- written since is not overwritten, and re-running this changes nothing.
-- stations.json moves in the same commit, so a reload of the stations doc
-- (load_stations_doc) does not put the copy back.

update meganet.station
   set deleted_at = now(),
       updated_by = '0104_loudoun_duplicate'
 where id = 'loudoun_br_al_2'
   and deleted_at is null
   and coalesce(station_number, '') = ''
   and alert_ids = '{"rainfall": 6129}'::jsonb;

update meganet.station
   set notes      = 'Position checked 5 Nov 2026 and kept: beside the Condamine at Loudoun Bridge, 18 m from '
                 || 'the state''s river gauge 422333A, where the Bureau''s 2024 station list puts it. '
                 || 'Not yet confirmed on site. '
                 || 'Until 23 Oct 2026 this record sat 28.5 km west, at the Loudoun Bridge Alert '
                 || '(Decoupled RG) rain gauge''s position. A second copy of this station (the same ALERT '
                 || 'addresses 6128–6130, no station number) stood 1.3 km north, away from the river, '
                 || 'on the hand-read Loudoun Bridge gauge; it was retired as a duplicate on 5 Nov 2026.',
       updated_by = '0104_loudoun_duplicate'
 where id = 'loudoun_br_al'
   and coalesce(notes, '') = '';

update meganet.station
   set notes      = 'Position checked 5 Nov 2026: the Bureau''s 2024 station list puts this gauge here, '
                 || 'about 1.3 km north of the Condamine and not at the river, where Loudoun Br AL and the '
                 || 'state''s river gauge stand. Worth checking where the gauge boards are on the next visit.',
       updated_by = '0104_loudoun_duplicate'
 where id = 'loudoun_bridge'
   and coalesce(notes, '') = '';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from meganet.station
              where id = 'loudoun_br_al_2' and deleted_at is null) then
    raise exception '0104 did not take: loudoun_br_al_2 is still in the register';
  end if;
  if exists (select 1 from meganet.station
              where id = 'loudoun_br_al' and (deleted_at is not null or coalesce(notes, '') = '')) then
    raise exception '0104 did not take: loudoun_br_al is gone or has no note';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 104 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '104')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
