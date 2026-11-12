-- 0119_one_18_bateson.sql — 18 Bateson is one station again: the workshop test
-- rig's sensors and readings move onto the site, and the rig's row is retired.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0119_one_18_bateson.sql
--
-- Why
-- ───
-- 0026 made the base station's bench sensors a second station row,
-- `bateson_test` ("18 Bateson workshop test rig"), beside the surveyed site
-- `18_bateson`, so that rain measured in a workshop could never be read as
-- gauged rainfall. In practice it meant two "18 Bateson"s in every search and
-- list, and the site's own pin showed none of the readings its base station
-- sends. The owner's decision (12 November 2026): one station. The readings
-- that come from the rig — s:999998/rain, /level_1, /level_2, /battery and the
-- self-test a:8101 — are now 18 Bateson's, and its notes say what they are.
--
-- What moves
-- ──────────
--   the five sensor rows        rain, level_1, level_2, battery and the
--                               ALERT2 self-test (8101) — onto 18_bateson
--   the station number 999998   onto 18_bateson, which had none; the logger and
--                               the Pi keep posting exactly what they post now,
--                               and resolve_station() answers 18_bateson
--   every reading filed under   reading, reading_hourly, reading_daily,
--   bateson_test                reading_newest (about 5,600 readings, Sept–Nov
--                               2026) — by reading_station_idx, never a scan
--   station_status              its one row, re-keyed (or dropped when the
--                               site already has one)
--   health_card                 the rig's cards dropped; the next health run
--                               writes 18 Bateson's
--
-- What stays: station_change keeps both stations' history as it was (it is
-- history), and the rig's row is soft-deleted, not removed — its number
-- cleared so that restoring it can never make 999998 ambiguous again.
--
-- On a database built from zero (CI), 18_bateson does not exist yet when this
-- runs — it arrives with stations.json, which now carries the sensors and the
-- number itself. So the rig is retired either way, and the moves happen only
-- where the site is there to take them.

do $$
declare
  v_site boolean := exists (select 1 from meganet.station where id = '18_bateson' and deleted_at is null);
  v_left text;
  v_tbl  text;
  v_col  text;
  v_hit  boolean;
begin
  -- 1 · The sensors. Copied first, then removed from the rig.
  if v_site then
    insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id)
    select '18_bateson', s.sensor_id, s.type,
           coalesce((select pg_catalog.max(x.ord) from meganet.sensor x where x.station_id = '18_bateson'), 0) + s.ord,
           s.alert_id
      from meganet.sensor s
     where s.station_id = 'bateson_test'
    on conflict (station_id, sensor_id, type) do nothing;
  end if;
  delete from meganet.sensor where station_id = 'bateson_test';

  -- 2 · Retire the rig: soft delete, number cleared, a note saying where it went.
  update meganet.station
     set deleted_at     = coalesce(deleted_at, pg_catalog.now()),
         station_number = '',
         enabled        = false,
         notes          = 'Merged into 18_bateson on 12 November 2026 (db/migrations/0119): '
                          || 'its sensors, station number 999998 and readings are 18 Bateson''s now.'
   where id = 'bateson_test'
     and (deleted_at is null or station_number <> '' or enabled);

  if not v_site then
    return;
  end if;

  -- 3 · The site takes the number, and a note saying what the readings are.
  update meganet.station
     set station_number = '999998'
   where id = '18_bateson' and station_number is distinct from '999998';
  update meganet.station
     set notes = 'The base station at 18 Bateson, with sensors wired to its logger in the workshop: '
                 || 'a tipping bucket (rain), two SDI-12 level sensors (level_1, level_2) and the supply '
                 || 'voltage (battery), posted as station number 999998, plus the logger''s ALERT2 '
                 || 'self-test on address 8101. These are bench readings for testing Flood-Net, '
                 || 'not gauged rainfall or river levels. Until 12 November 2026 they were filed under a '
                 || 'separate station, "18 Bateson workshop test rig" (bateson_test).'
   where id = '18_bateson' and coalesce(notes, '') = '';

  -- 4 · The readings and their rollups.
  update meganet.reading        set station_id = '18_bateson' where station_id = 'bateson_test';
  update meganet.reading_hourly set station_id = '18_bateson' where station_id = 'bateson_test';
  update meganet.reading_daily  set station_id = '18_bateson' where station_id = 'bateson_test';
  update meganet.reading_newest set station_id = '18_bateson' where station_id = 'bateson_test';

  -- 5 · When it was last heard.
  if exists (select 1 from meganet.station_status where station_key = '18_bateson') then
    delete from meganet.station_status where station_key = 'bateson_test';
  else
    update meganet.station_status
       set station_key = '18_bateson', station_id = '18_bateson'
     where station_key = 'bateson_test';
  end if;
  update meganet.station_status set station_id = '18_bateson' where station_id = 'bateson_test';

  -- 6 · Health cards are rebuilt on every run; the rig's go.
  delete from meganet.health_card where station_id = 'bateson_test';

  -- 7 · Nothing else may still point at the rig. Every table with a station id
  --     column is asked, by name, so a table added after this file was written
  --     is asked too. History (station_change, station_lpu_change) is exempt.
  for v_tbl, v_col in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'meganet'
       and c.column_name in ('station_id', 'host_station_id')
       and c.table_name not in ('station_change', 'station_lpu_change')
  loop
    execute pg_catalog.format('select exists (select 1 from meganet.%I where %I = %L)', v_tbl, v_col, 'bateson_test')
       into v_hit;
    if v_hit then
      v_left := coalesce(v_left || ', ', '') || v_tbl || '.' || v_col;
    end if;
  end loop;
  if v_left is not null then
    raise exception '0119 did not take: still filed under bateson_test in %', v_left;
  end if;
end
$$;

-- ── Check ────────────────────────────────────────────────────────────────────
-- Both of the rig's addresses answer 18_bateson now — or, on a database built
-- from zero where the site is still to come, at least no longer the rig.
do $$
declare
  v_site boolean := exists (select 1 from meganet.station where id = '18_bateson' and deleted_at is null);
begin
  if exists (select 1 from meganet.station where id = 'bateson_test' and deleted_at is null) then
    raise exception '0119 did not take: bateson_test is still a live station';
  end if;
  if exists (select 1 from meganet.sensor where station_id = 'bateson_test') then
    raise exception '0119 did not take: bateson_test still has sensors';
  end if;
  if v_site and meganet.resolve_station(null, '999998') is distinct from '18_bateson' then
    raise exception '0119 did not take: resolve_station(null, ''999998'') = %',
      coalesce(meganet.resolve_station(null, '999998'), '(null)');
  end if;
  if v_site and meganet.resolve_station(8101, null) is distinct from '18_bateson' then
    raise exception '0119 did not take: resolve_station(8101) = %',
      coalesce(meganet.resolve_station(8101, null), '(null)');
  end if;
end
$$;

-- DB_SCHEMA_VERSION in core.js goes 118 → 119 in the same commit.
insert into meganet.app_meta (key, value)
values ('schema_version', '119')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
