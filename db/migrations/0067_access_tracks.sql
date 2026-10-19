-- 0067_access_tracks.sql — The way in to a station, as one of its site
-- features: the road or track driven to it, a line ending at the site.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0067_access_tracks.sql
--
-- Why this file exists
-- ────────────────────
-- Twenty years of GPS tracks driven to stations came in as a Google Earth KML
-- (October 2026): the roads and property tracks somebody followed to a gauge,
-- through which gate, past which creek crossing. That is the first thing
-- somebody new to a site needs and the last thing written down anywhere, and
-- 0061 already has a home for a line at a station — editors only, within
-- 10 km of the pin, at most 500 points, how it was placed and when.
--
-- What 0061 did not have is the kind. Its *other line* would take a track,
-- named, but it would take a fence and a drain too, drawn alike, and an access
-- track is not an afterthought among those: it is the one line nearly every
-- station has. So it is a kind of its own, drawn in its own colour on the map
-- (site-features.js) and found by kind rather than by a name somebody typed.
-- A new kind is an insert — 0061 says so, and this is all this file is.
--
-- Nothing else changes. The 10 km reach, the 500 points, the editors-only
-- reading (a route across somebody's land to a locked gate is not for the open
-- internet) and the two doors are 0061's, and hold for this kind as for the
-- rest. tools/ingest/access_tracks.py is what turned the KML into lines that
-- fit them; its notes say, on each row, where the line came from.
--
-- Depends on 0061. tools/check_station_features.sql proves it.

insert into meganet.station_feature_kind (key, label, geometry, needs_name, ord, note) values
  ('access_track', 'Access track', 'LineString', false, 130, 'The way in to the site — the road or track driven to it, ending at the station.')
on conflict (key) do nothing;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 67 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '67')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
