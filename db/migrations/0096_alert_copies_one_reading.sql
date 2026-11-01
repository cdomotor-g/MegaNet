-- 0096_alert_copies_one_reading.sql — One ALERT burst heard several ways is
-- one reading with every path it came by, not one row per copy (#232).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0096_alert_copies_one_reading.sql
--
-- Why this file exists
-- ────────────────────
-- ingest() keeps a reading it has already stored as a duplicate on
-- (addr, reading_ts, value_raw) (0006) — counted, its path added to dup_paths.
-- That key assumes every copy of a reading carries the same time. A legacy
-- ALERT frame carries no time at all: whoever hears it stamps it on arrival —
-- the Pi to the millisecond, the browser's Serial Monitor to the millisecond,
-- an ALERT2 concentrator to the second as "so many seconds before this PDU" —
-- and the copies of one burst arrive by different routes at different times.
-- So the key never matched for them. Measured on the live database
-- (#232, 1 November 2026):
--
--   * 3 days, 69,782 readings on an ALERT address: 4,094 of them (5.9 %) had a
--     twin — the same address and value within 2 s under another time. Not
--     one of the 21,327 plain legacy readings was counted a duplicate.
--   * The twins are relays, not two sticks: one Pi, two channels, mostly the
--     ALERT2 concentrators' copy on 151.5375 and a legacy repeater's on
--     151.525 about a second apart. Across channels the copies of one burst
--     land within 8 s of each other — 0-1 s 1,226, 1-2 s 570, 2-3 s 578,
--     3-4 s 339, 4-5 s 116, 5-6 s 43, 6-8 s 8, and 8-10 s none.
--   * An ALERT2 concentrator relays the same burst several times itself: one
--     PDU from concentrator 33300 carried a:4080 = 1 three times, 12, 11 and
--     6 s before its stamp — the burst direct and through two repeaters. The
--     Pi already takes copies within 2 s as one (alert2-readings.js); the one
--     6 s later was stored again.
--   * A station sending the same value again is slower than that. In a week
--     of plain legacy readings (about 40,000), the same address and value on
--     the same channel came round again within 10 s twice; on the two busiest
--     channels never sooner than 10.0 and 11.1 s.
--
-- What changes
-- ────────────
--   1. ingest() takes a reading on an ALERT address (alert_id, whichever
--      protocol carried it — legacy, or an ALERT2 concentration record) as a
--      copy of one already stored when that one has the same address and value
--      and a time within the window either side: counted on it, its path added
--      to its dup_paths, as an exact duplicate always was. Nothing else
--      changes. An ALERT2 self-report (a2_station) and a logger's reading
--      (station_number) carry their own time from the station's clock, so for
--      them the exact key stays the whole test.
--   2. The window is meganet.app_meta's alert_copy_window_s: 8 seconds, from
--      the numbers above — wider than any relay seen, narrower than any repeat.
--      0 turns it off (the exact key alone, as before); anything that is not a
--      number from 0 to 60 is read as 8, so a typo there never stops a reading.
--   3. Two receivers posting one burst at the same moment must not each find
--      nothing and both store it. A call carrying any ALERT address takes one
--      transaction lock before its first row, so such calls take turns; they
--      are milliseconds long. Taken before any row is touched, so it cannot
--      wait on a call that waits on it.
--
-- The kept row is the copy stored first, its time, path, frequency and signal
-- (0050) — the window moves nothing already stored. Every copy is still in
-- meganet.reception, one row per frame heard (0047), which is what Signal
-- Routes, the carrier roll-ups and Who corrupts read; their pairing of a
-- burst's copies (0077, 0078, 0092) is over receptions and is not touched.
-- Readings already stored twice stay as they are: this is about what comes in.
--
-- The app reads dup_count and dup_paths as the copies heard already — the
-- Message Log's "heard 3 times", the Reception Map's votes. Station Health
-- counted only the kept copy's path; health-analysis.js now counts every path
-- in dup_paths too, so a receiver whose copies land second is not taken for
-- one gone quiet. Copies of one burst are copies of one reading anywhere in
-- Station Health within 12 s (COPY_WINDOW), so the 8 s here sits inside it.

-- ── 1. The window ────────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('alert_copy_window_s', '8')
on conflict (key) do nothing;

-- ── 2. ingest() ──────────────────────────────────────────────────────────────
-- Restated in full, 0050's text with the window added — create or replace
-- takes the whole body or none of it. The live body was checked against
-- 0050's, byte for byte (md5 dea2ac6a…), before this was written. Four places
-- change: two declarations, the window and the lock before the rows, the
-- look for an earlier copy before the insert, and the duplicate's update
-- finding that copy by its own time.

create or replace function meganet.ingest(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows        jsonb;
  v_env         jsonb := '{}'::jsonb;
  v_raw_id      bigint;
  v_keep_raw    boolean;
  v_now         timestamptz := pg_catalog.now();
  v_actor       text := meganet.actor();

  v_def_source   smallint;
  v_def_protocol smallint;
  v_def_path     text;
  v_def_recv     timestamptz;
  v_def_freq     numeric;

  r              jsonb;
  i              integer := -1;
  n_ok           integer := 0;
  n_dup          integer := 0;
  v_rejected     jsonb := '[]'::jsonb;

  v_alert     integer;
  v_a2_stn    integer;
  v_a2_sen    integer;
  v_sn        text;
  v_channel   text;
  v_ts        timestamptz;
  v_recv      timestamptz;
  v_raw       numeric;
  v_val       numeric;
  v_unit      text;
  v_conv      text;
  v_quality   smallint;
  v_protocol  smallint;
  v_source    smallint;
  v_path      text;
  v_freq      numeric;
  v_rssi      real;
  v_level     real;
  v_snr       real;
  v_addr      text;
  v_station   text;
  v_written   integer;
  v_window    interval;
  v_match_ts  timestamptz;

  -- A device with a dead RTC reports 1970 or 2106; both are stored nowhere. The
  -- floor is low enough for any backfill anyone will actually do and high enough
  -- that an epoch-zero clock is caught. The ceiling is tomorrow, because a
  -- station whose clock is an hour fast is a real and tolerable thing and one
  -- whose clock is a year fast is not.
  c_ts_floor  constant timestamptz := '1990-01-01T00:00:00Z';
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write readings'
      using errcode = '42501',
            hint    = 'ingest runs as an editor or with the service key; device credentials are #B5''s job';
  end if;

  -- ── The envelope ──
  if payload is null or pg_catalog.jsonb_typeof(payload) = 'null' then
    raise exception 'ingest was given nothing to store'
      using errcode = '22023';
  elsif pg_catalog.jsonb_typeof(payload) = 'array' then
    v_rows := payload;
  elsif pg_catalog.jsonb_typeof(payload) = 'object' and payload ? 'readings' then
    v_env  := payload;
    v_rows := payload -> 'readings';
    if pg_catalog.jsonb_typeof(v_rows) <> 'array' then
      raise exception 'readings must be an array, got %', pg_catalog.jsonb_typeof(v_rows)
        using errcode = '22023';
    end if;
  elsif pg_catalog.jsonb_typeof(payload) = 'object' then
    -- One reading, unwrapped. Common enough from a device that it is worth
    -- accepting rather than making every adapter wrap it.
    v_env  := payload;
    v_rows := pg_catalog.jsonb_build_array(payload);
  else
    raise exception 'ingest takes an array of readings, or an object with a readings array — got %',
                    pg_catalog.jsonb_typeof(payload)
      using errcode = '22023';
  end if;

  -- Envelope defaults. Every one of these can be overridden per row, because a
  -- backfill of a mixed archive is one batch carrying several protocols.
  v_def_source   := coalesce(meganet.code_for('ingest_source', v_env -> 'source',   'source'), 0::smallint);
  v_def_protocol := coalesce(meganet.code_for('protocol',      v_env -> 'protocol', 'protocol'), 0::smallint);
  v_def_path     := nullif(pg_catalog.btrim(coalesce(v_env ->> 'path', '')), '');
  v_def_recv     := coalesce(meganet.as_ts(v_env -> 'received_at', 'received_at'), v_now);
  v_keep_raw     := coalesce((v_env ->> 'keep_raw')::boolean, true);
  -- One receiver channel is one frequency, so a batch from one may say it
  -- once, the way it says its path once (0050).
  v_def_freq     := meganet.as_num_within(v_env -> 'freq_mhz', 0.001, 100000);

  -- How far apart two copies of one ALERT reading may be stamped (0096):
  -- app_meta's alert_copy_window_s, 0-60 s; missing or not a number, 8.
  v_window := pg_catalog.make_interval(secs => coalesce(
                (select meganet.as_num_within(pg_catalog.to_jsonb(a.value), 0, 60)
                   from meganet.app_meta a where a.key = 'alert_copy_window_s'),
                8)::double precision);

  -- Two receivers posting one burst at once must not both find no copy and
  -- both store it, so a call carrying an ALERT address waits its turn here,
  -- before it has touched a row — it holds nothing another call could want
  -- while it waits. The lock goes with the transaction (0096).
  if v_window > interval '0' and exists (
       select 1 from pg_catalog.jsonb_array_elements(v_rows) e
        where pg_catalog.jsonb_typeof(e) = 'object'
          and pg_catalog.jsonb_typeof(e -> 'alert_id') <> 'null') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('meganet.ingest_alert_copies')::bigint);
  end if;

  if v_keep_raw then
    insert into meganet.reading_raw (received_at, source, protocol, path, payload, frame, submitted_by)
    values (v_def_recv, v_def_source, v_def_protocol, v_def_path, payload,
            nullif(v_env ->> 'frame', ''), v_actor)
    returning id into v_raw_id;
  end if;

  -- ── The rows ──
  for r in select value from pg_catalog.jsonb_array_elements(v_rows) loop
    i := i + 1;
    begin
      if pg_catalog.jsonb_typeof(r) <> 'object' then
        raise exception 'a reading must be an object, got %', pg_catalog.jsonb_typeof(r)
          using errcode = '22023';
      end if;

      -- Address. One of the three, at least; the ALERT address wins when both it
      -- and a station number are given, because that is what the packet was
      -- addressed to.
      v_alert := null;
      if r ? 'alert_id' and pg_catalog.jsonb_typeof(r -> 'alert_id') <> 'null' then
        v_alert := meganet.as_num(r -> 'alert_id', 'alert_id')::integer;
        if v_alert < 1 or v_alert > 65535 then
          raise exception 'alert_id % is outside 1-65535', v_alert using errcode = '23514';
        end if;
      end if;

      -- The relayed ALERT2 pair. Both halves or neither: a sensor slot with no
      -- station is the #169 defect this file exists to close, and accepting it
      -- here would file it under somebody else's ALERT address all over again.
      v_a2_stn := null;
      v_a2_sen := null;
      if r ? 'a2_station' and pg_catalog.jsonb_typeof(r -> 'a2_station') <> 'null' then
        v_a2_stn := meganet.as_num(r -> 'a2_station', 'a2_station')::integer;
        if v_a2_stn < 1 or v_a2_stn > 65535 then
          raise exception 'a2_station % is outside 1-65535', v_a2_stn using errcode = '23514';
        end if;
      end if;
      if r ? 'a2_sensor' and pg_catalog.jsonb_typeof(r -> 'a2_sensor') <> 'null' then
        v_a2_sen := meganet.as_num(r -> 'a2_sensor', 'a2_sensor')::integer;
        if v_a2_sen = 255 then
          raise exception 'a2_sensor 255 is ELPRO''s unused-slot marker, not a sensor'
            using errcode = '23514';
        end if;
        if v_a2_sen < 0 or v_a2_sen > 254 then
          raise exception 'a2_sensor % is outside 0-254', v_a2_sen using errcode = '23514';
        end if;
      end if;
      if (v_a2_stn is null) <> (v_a2_sen is null) then
        raise exception 'an ALERT2 reading needs both a2_station and a2_sensor — half a pair names nothing'
          using errcode = '23514';
      end if;
      if v_a2_stn is not null and v_alert is not null then
        raise exception 'a reading carries an ALERT address or an ALERT2 pair, not both'
          using errcode = '23514';
      end if;

      v_sn      := nullif(pg_catalog.btrim(coalesce(r ->> 'station_number', '')), '');
      v_channel := pg_catalog.btrim(coalesce(r ->> 'channel', ''));

      if v_alert is null and v_a2_stn is null and v_sn is null then
        raise exception 'no address: a reading needs an alert_id, an ALERT2 pair, or a station_number for a station that has none'
          using errcode = '23514';
      end if;
      if v_alert is not null or v_a2_stn is not null then
        -- The address is the sensor. A channel alongside it is redundant, and
        -- the submission is kept whole in reading_raw either way.
        v_channel := '';
        v_sn      := pg_catalog.left(coalesce(v_sn, ''), 32);
        v_sn      := nullif(v_sn, '');
      elsif pg_catalog.length(v_channel) > 64 then
        raise exception 'channel is longer than 64 characters' using errcode = '22001';
      elsif pg_catalog.length(v_sn) > 32 then
        raise exception 'station_number is longer than 32 characters' using errcode = '22001';
      end if;

      -- Time. Both of them, and neither absurd.
      v_ts := meganet.as_ts(r -> 'reading_ts', 'reading_ts');
      if v_ts is null then
        raise exception 'reading_ts is required' using errcode = '23502';
      end if;
      if v_ts < c_ts_floor then
        raise exception 'reading_ts % is before 1990 — a dead clock, not a reading', v_ts
          using errcode = '22008';
      end if;
      if v_ts > v_now + interval '1 day' then
        raise exception 'reading_ts % is more than a day in the future', v_ts
          using errcode = '22008';
      end if;

      v_recv := coalesce(meganet.as_ts(r -> 'received_at', 'received_at'), v_def_recv);
      if v_recv < c_ts_floor or v_recv > v_now + interval '1 day' then
        raise exception 'received_at % is not a plausible time', v_recv using errcode = '22008';
      end if;

      -- Value.
      v_raw := meganet.as_num(r -> 'value_raw', 'value_raw');
      if v_raw is null then
        -- A source with no counts sends only the engineering value; that value
        -- is then what was transmitted, and so is the raw one.
        v_raw := meganet.as_num(r -> 'value', 'value');
        if v_raw is null then
          raise exception 'value_raw is required' using errcode = '23502';
        end if;
      end if;
      v_val := meganet.as_num(r -> 'value', 'value');

      v_unit := nullif(pg_catalog.btrim(coalesce(r ->> 'unit', '')), '');
      if v_unit is not null
         and not exists (select 1 from meganet.unit u where u.key = v_unit) then
        raise exception 'unknown unit: % — add it to meganet.unit if it is real', v_unit
          using errcode = '23514';
      end if;
      v_conv := nullif(pg_catalog.btrim(coalesce(r ->> 'conversion', '')), '');

      -- Vocabularies, falling back to the envelope.
      v_quality  := coalesce(meganet.code_for('quality', r -> 'quality', 'quality'), 0::smallint);
      v_protocol := coalesce(meganet.code_for('protocol', r -> 'protocol', 'protocol'), v_def_protocol);
      v_source   := coalesce(meganet.code_for('ingest_source', r -> 'source', 'source'), v_def_source);
      v_path     := coalesce(nullif(pg_catalog.btrim(coalesce(r ->> 'path', '')), ''), v_def_path);
      v_path     := pg_catalog.left(v_path, 200);

      -- How this copy was heard (0050): the frequency, and the signal in
      -- whichever terms the receiver can measure it. Never a reason to refuse
      -- the reading — a value that is missing, not a number or not plausible
      -- is stored as null, and the submission keeps what was sent.
      v_freq  := pg_catalog.round(coalesce(
                   meganet.as_num_within(r -> 'freq_mhz', 0.001, 100000), v_def_freq), 6);
      -- Rounded before the cast to real: 1e-50 is in range and a number, and
      -- as a real it is an underflow error that would cost the reading.
      v_rssi  := pg_catalog.round(meganet.as_num_within(r -> 'rssi_dbm',   -200, 50), 2)::real;
      v_level := pg_catalog.round(meganet.as_num_within(r -> 'level_dbfs', -200, 20), 2)::real;
      v_snr   := pg_catalog.round(meganet.as_num_within(r -> 'snr_db',     -100, 200), 2)::real;

      -- station_id is resolved here and never read from the payload. A client
      -- that can name the station is a client that can name the wrong one. The
      -- ALERT2 address goes first because a row carrying one carries no ALERT
      -- address at all, so the coalesce is a preference order over disjoint
      -- cases rather than a fallback through an ambiguous match.
      v_station := coalesce(meganet.resolve_a2_station(v_a2_stn),
                            meganet.resolve_station(v_alert, v_sn));

      -- Kept in lockstep with the generated column by hand. There is no way to
      -- ask Postgres for the expression, and a copy that drifts does not fail —
      -- it makes the duplicate-counter UPDATE below miss, and a reading heard
      -- twice is silently stored twice instead of counted.
      v_addr := case when v_alert   is not null then 'a:'  || v_alert
                     when v_a2_stn  is not null then 'a2:' || v_a2_stn || '/' || v_a2_sen
                     else 's:' || coalesce(v_sn, '') || '/' || v_channel end;

      -- An ALERT address's reading carries no time of its own: the time is
      -- when somebody heard it — a Pi, a browser, an ALERT2 concentrator —
      -- and each copy of one burst comes by its own route, seconds apart.
      -- The same address and value within the window either side is that
      -- reading heard again (0096). The nearest such copy, if there is one,
      -- is the reading; the primary key's index finds it.
      v_match_ts := null;
      if v_alert is not null and v_window > interval '0' then
        select d.reading_ts into v_match_ts
          from meganet.reading d
         where d.addr = v_addr
           and d.reading_ts between v_ts - v_window and v_ts + v_window
           and d.value_raw = v_raw
         order by pg_catalog.abs(extract(epoch from d.reading_ts - v_ts)), d.reading_ts
         limit 1;
      end if;

      if v_match_ts is null then
        insert into meganet.reading (
          alert_id, a2_station, a2_sensor, station_number, channel, station_id,
          reading_ts, received_at, value_raw, value, unit, conversion,
          quality, protocol, source, path, raw_id,
          freq_mhz, rssi_dbm, level_dbfs, snr_db)
        values (
          v_alert, v_a2_stn, v_a2_sen, v_sn, v_channel, v_station,
          v_ts, v_recv, v_raw, v_val, v_unit, v_conv,
          v_quality, v_protocol, v_source, v_path, v_raw_id,
          v_freq, v_rssi, v_level, v_snr)
        on conflict (addr, reading_ts, value_raw) do nothing;

        get diagnostics v_written = row_count;
      else
        v_written := 0;
      end if;

      if v_written = 1 then
        n_ok := n_ok + 1;
      else
        -- Already heard. Count it, and remember the path it came by if it is one
        -- we have not seen for this reading — that is the repeater diagnostic.
        -- Capped at eight, because a reading heard by nine paths has already
        -- made its point and an unbounded array on a table this size has not.
        -- Its frequency and signal are not kept: the row describes the copy
        -- stored first, as its path does (0050). For an ALERT address, "already
        -- heard" is the copy found within the window above (0096).
        n_dup := n_dup + 1;
        update meganet.reading d
           set dup_count   = d.dup_count + 1,
               last_dup_at = v_recv,
               dup_paths   = case
                 when v_path is null
                   or v_path = coalesce(d.path, '')
                   or v_path = any (d.dup_paths)
                   or pg_catalog.cardinality(d.dup_paths) >= 8
                 then d.dup_paths
                 else d.dup_paths || v_path end
         where d.addr = v_addr and d.reading_ts = coalesce(v_match_ts, v_ts)
           and d.value_raw = v_raw;
      end if;

    exception when others then
      v_rejected := v_rejected || pg_catalog.jsonb_build_object('i', i, 'why', sqlerrm);
    end;
  end loop;

  if v_raw_id is not null then
    update meganet.reading_raw
       set accepted   = n_ok,
           duplicates = n_dup,
           rejected   = pg_catalog.jsonb_array_length(v_rejected)
     where id = v_raw_id;
  end if;

  return pg_catalog.jsonb_build_object(
           'accepted',   n_ok,
           'duplicates', n_dup,
           'rejected',   v_rejected,
           'raw_id',     v_raw_id);
end;
$$;

comment on function meganet.ingest(jsonb) is
  'The one way in. Takes a batch, validates each row, deduplicates against the primary key, resolves station_id where it can, and returns {accepted, duplicates, rejected:[{i,why}], raw_id}. One bad row never costs the batch. Since 0050 a row may say how it was heard — freq_mhz, rssi_dbm, level_dbfs, snr_db — and a bad one of those is stored as null rather than refused. Since 0096 a reading on an ALERT address is a duplicate of one with the same address and value stamped within app_meta''s alert_copy_window_s (8 s) either side, since its time is only when somebody heard it.';

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from meganet.app_meta where key = 'alert_copy_window_s') then
    raise exception '0096 did not take: app_meta has no alert_copy_window_s';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'meganet.ingest(jsonb)'::pg_catalog.regprocedure
                    and p.prosrc like '%alert_copy_window_s%'
                    and p.prosrc like '%coalesce(v_match_ts, v_ts)%'
                    and p.prosrc like '%meganet.ingest_alert_copies%'
                    and p.prosrc like '%freq_mhz, rssi_dbm, level_dbfs, snr_db%') then
    raise exception '0096 did not take: meganet.ingest() does not look for a copy within the window';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    if pg_catalog.has_function_privilege('anon', 'meganet.ingest(jsonb)', 'execute') then
      raise exception '0096 did not take: anon can execute meganet.ingest()';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 95 → 96 once db-migrate.yml has applied
-- this file, as the last few have.

insert into meganet.app_meta (key, value)
values ('schema_version', '96')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
