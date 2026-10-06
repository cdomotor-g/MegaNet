-- 0050_reading_signal.sql — On what frequency a reading was heard, and how
-- strongly: the receiver's half of the record, on the reading itself.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0050_reading_signal.sql
--
-- Why this file exists
-- ────────────────────
-- A base station knows two things about every reading it hears that the
-- reading table had nowhere to put: the frequency it heard it on, and how
-- strong it was. The Message Log is where somebody doing fade-margin work or
-- commissioning a site looks, and neither was there. Two of its columns look
-- as if they might be, and are not:
--
--   * `channel` is which sensor spoke, for a station addressed by its number
--     (0006). An ALERT address *is* its sensor, so a radio reading's channel
--     is '' by constraint, always.
--   * `quality` is what the source asserts about the value — unqualified,
--     good, suspect — not how loudly it arrived.
--
-- The frequency survived only inside `path`, and only for a Raspberry Pi's
-- second and later channels on one stick (serial-monitor/rpi-…-sdr1-152.400);
-- the stick's own channel is named without one. The signal was being kept —
-- every frame a receiver hears goes to meganet.reception (0047) with its
-- level — but that is the Reception Map's raw material: another stream, one
-- row per frame including the bad ones, readable by editors only, and joined
-- to a reading by nothing sturdier than the moment and the value.
--
-- What changes
-- ────────────
--   1. Four nullable columns on meganet.reading:
--        freq_mhz    the frequency it was heard on, in MHz.
--        rssi_dbm    received signal strength in dBm, from a receiver that
--                    measures it in dBm — a radio, an ERT-A2.
--        level_dbfs  the burst's level against the receiver's full scale, in
--                    dBFS — what an RTL-SDR can say, since it is not
--                    calibrated in dBm. Comparable within one receiver at one
--                    gain, not between receivers.
--        snr_db      signal over the receiver's own noise floor, in dB — the
--                    one figure comparable across all of them, and the nearest
--                    thing a base station has to a measured fade margin.
--      Added without defaults, so this is a catalogue change rather than a
--      rewrite, and every row stored before it reads null — which is true:
--      nobody said.
--   2. ingest() reads them from each reading, and freq_mhz from the envelope
--      too, the way path and protocol fall back to it.
--
-- They never cost a reading. They describe how one copy was heard, not what
-- was measured, and a rainfall tip is not lost because a radio reported an
-- RSSI of +300: a value that is missing, not a number or out of the range
-- below is stored as null, and the submission is in reading_raw for 30 days
-- for whoever wants to know why. That is the opposite of value_raw and unit,
-- which refuse the row with a sentence, because without them there is no
-- reading to keep.
--
-- They describe the copy that was kept — the first stored, the one `path`
-- names (0006). A further copy's path still goes to dup_paths; its frequency
-- and signal do not. A reading heard three ways is one row, and per-copy
-- detail is meganet.reception's job, not a third array on a table heading for
-- millions of rows.
--
-- Public, as the rest of the reading is: the grants on meganet.reading are per
-- table, so the columns inherit them. Reception (0047) is editors-only because
-- a reception carries where the receiver was, which for a vehicle is where
-- somebody went; a reading carries no position, and a fixed base station's
-- frequency and signal tell nobody anything about a person.

-- ── The columns ──────────────────────────────────────────────────────────────
-- numeric for the frequency, as rx_mhz and tx_mhz are (0002, 0033): it is an
-- identifier as much as a measurement — "everything heard on 151.525" is an
-- equality — and a float would make that a range query. real for the levels,
-- as meganet.reception has them: a tenth of a dB is already more than any of
-- these receivers can tell apart.

alter table meganet.reading
  add column if not exists freq_mhz   numeric,
  add column if not exists rssi_dbm   real,
  add column if not exists level_dbfs real,
  add column if not exists snr_db     real;

comment on column meganet.reading.freq_mhz is
  'The frequency the kept copy was heard on, MHz (0050). Null when the adapter did not say — every reading before 0050, and anything not heard off the air.';
comment on column meganet.reading.rssi_dbm is
  'Received signal strength of the kept copy, dBm, from a receiver that measures in dBm — a radio, an ERT-A2 (0050). An RTL-SDR is not calibrated in dBm and reports level_dbfs instead.';
comment on column meganet.reading.level_dbfs is
  'The kept copy''s burst level against the receiver''s full scale, dBFS — an RTL-SDR''s signal figure (0050). Comparable within one receiver at one gain, not between receivers.';
comment on column meganet.reading.snr_db is
  'The kept copy''s signal over the receiver''s noise floor, dB (0050). The one signal figure comparable across receivers.';

-- Belt and braces: ingest() stores null for anything outside these, so the
-- constraints only ever refuse a write that went round it. The same ranges,
-- so the two cannot disagree about what is plausible. NaN is greater than
-- every number in Postgres, so the upper bounds refuse it too.
alter table meganet.reading drop constraint if exists reading_freq_mhz_range;
alter table meganet.reading add constraint reading_freq_mhz_range check (
  freq_mhz is null or (freq_mhz >= 0.001 and freq_mhz <= 100000));
alter table meganet.reading drop constraint if exists reading_rssi_dbm_range;
alter table meganet.reading add constraint reading_rssi_dbm_range check (
  rssi_dbm is null or (rssi_dbm >= -200 and rssi_dbm <= 50));
alter table meganet.reading drop constraint if exists reading_level_dbfs_range;
alter table meganet.reading add constraint reading_level_dbfs_range check (
  level_dbfs is null or (level_dbfs >= -200 and level_dbfs <= 20));
alter table meganet.reading drop constraint if exists reading_snr_db_range;
alter table meganet.reading add constraint reading_snr_db_range check (
  snr_db is null or (snr_db >= -100 and snr_db <= 200));

-- ── A number, or nothing ─────────────────────────────────────────────────────
-- as_num()'s lenient sibling. as_num() raises, because a value_raw that is not
-- a number is a reading that cannot be stored, and the sender needs a sentence
-- saying so. These fields are the other case: the reading stands without
-- them, so a bad one becomes null instead of costing the row. plpgsql rather
-- than SQL on purpose — an inlined SQL function's cast can be folded at plan
-- time for a constant argument and raise before the regex has ruled it out.
-- The exponent is held to three digits for the same reason: '1e999999' is a
-- number to the regex and an overflow to the cast.
create or replace function meganet.as_num_within(p_value jsonb, p_lo numeric, p_hi numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_txt text;
  v_num numeric;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) not in ('number', 'string') then
    return null;
  end if;
  v_txt := pg_catalog.btrim(p_value #>> '{}');
  if v_txt !~ '^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,3})?$' then
    return null;
  end if;
  v_num := v_txt::numeric;
  if v_num < p_lo or v_num > p_hi then
    return null;
  end if;
  return v_num;
end;
$$;

comment on function meganet.as_num_within(jsonb, numeric, numeric) is
  'A JSON number (or numeric string) between two bounds, else null — never an error. For fields a reading stands without, such as its frequency and signal (0050).';

revoke all on function meganet.as_num_within(jsonb, numeric, numeric) from public;

-- ── ingest() ─────────────────────────────────────────────────────────────────
-- Restated in full, 0024's text with the frequency and signal added — the way
-- 0024 restated 0006's, because create or replace takes the whole body or none
-- of it. Four places change: the envelope's frequency, the per-row parse, the
-- insert, and a note on the duplicate branch. The live body was checked
-- against 0024's, byte for byte, before this was written.

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

      if v_written = 1 then
        n_ok := n_ok + 1;
      else
        -- Already heard. Count it, and remember the path it came by if it is one
        -- we have not seen for this reading — that is the repeater diagnostic.
        -- Capped at eight, because a reading heard by nine paths has already
        -- made its point and an unbounded array on a table this size has not.
        -- Its frequency and signal are not kept: the row describes the copy
        -- stored first, as its path does (0050).
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
         where d.addr = v_addr and d.reading_ts = v_ts and d.value_raw = v_raw;
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
  'The one way in. Takes a batch, validates each row, deduplicates against the primary key, resolves station_id where it can, and returns {accepted, duplicates, rejected:[{i,why}], raw_id}. One bad row never costs the batch. Since 0050 a row may say how it was heard — freq_mhz, rssi_dbm, level_dbfs, snr_db — and a bad one of those is stored as null rather than refused.';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- ingest() is security definer, so this is for nothing it does; it matches
  -- the grants on as_num() and as_ts() (0006), its siblings.
  grant execute on function meganet.as_num_within(jsonb, numeric, numeric) to authenticated, service_role;
  -- The anon and authenticated grants on meganet.reading are per table, so the
  -- four columns are readable already — but PostgREST caches the column list,
  -- and a cache from before this file would refuse them as unknown.
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if (select pg_catalog.count(*) from information_schema.columns
       where table_schema = 'meganet' and table_name = 'reading'
         and column_name in ('freq_mhz', 'rssi_dbm', 'level_dbfs', 'snr_db')) <> 4 then
    raise exception '0050 did not take: meganet.reading is missing a frequency or signal column';
  end if;
  if to_regprocedure('meganet.as_num_within(jsonb, numeric, numeric)') is null then
    raise exception '0050 did not take: meganet.as_num_within() is missing';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'meganet.ingest(jsonb)'::pg_catalog.regprocedure
                    and p.prosrc like '%freq_mhz, rssi_dbm, level_dbfs, snr_db%') then
    raise exception '0050 did not take: meganet.ingest() does not write the frequency and signal';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    if pg_catalog.has_function_privilege('anon', 'meganet.ingest(jsonb)', 'execute') then
      raise exception '0050 did not take: anon can execute meganet.ingest()';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 49 → 50 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '50')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
