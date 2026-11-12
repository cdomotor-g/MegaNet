-- 0121_alert2_shared_ids.sql — One ALERT2 ID, several stations, told apart by
-- sensor; the owner's station links from the slot sheet; Maleny WWTP.
--
-- Why this file exists
-- ────────────────────
-- 0024 gave each station at most one ALERT2 station address, and each address
-- to at most one station, because two stations on one address "would resolve
-- to neither". But one ALERT2 logger often serves two register stations at one
-- site: a weir's headwater and tailwater gauges. The slot sheet (0120) has two
-- such: Bromelton Weir HW/TW on 11047, Cedar Grove (Weir HW and TW) on 11081.
-- ALERT2 already says which instrument a value is — the sensor number (0024's
-- slot, sensor.alert2_sensor_id) — so the address can be shared and the slot
-- decides.
--
-- Which slot is which comes from what the base stations decoded of each site's
-- own report (reception.detail.sensors, 10–12 November 2026). Both send two
-- water levels, on sensors 7 and 17, and a battery on 8:
--
--   11047 Bromelton   7 → 40.83 m   17 → 0.86 m    8 → 13.2 V
--   11081 Cedar Grove 7 → 20.66 m   17 → 14.91 m   8 → 13.3 V
--
-- At both, 7 reads the higher level — the headwater, above the weir — so 7 is
-- the HW station's and 17 the TW station's; the battery goes with the HW
-- station. If a site visit says otherwise, swapping the two slots on the
-- stations' sensors (the station editor) puts it right; no reading is stored
-- under these addresses yet, because the base stations' ALERT2 self-reports
-- are kept as receptions, not readings.
--
-- What changes
-- ────────────
--   1. station_alert2_unique_idx goes; a plain index takes its place.
--   2. resolve_a2_sensor(address, slot): the only station holding the
--      address, else the one holder whose sensor carries the slot, else null.
--      resolve_a2_station(address) is unchanged — "the only holder" — for the
--      transmitter-level callers (health, carriers), which ask about a radio,
--      not an instrument.
--   3. ingest() and resolve_readings() resolve an ALERT2 reading by address
--      and slot. Restated in full from 0096 and 0024; one call changes in each.
--   4. save_station() allows a shared address when this station names its
--      slots and none is another holder's. Restated in full from 0117; that
--      one block changes.
--   5. Maleny WWTP, a new station at -26.765182, 152.867250 (the owner's
--      position), holding 8278 — not Maleny AL, which is another site.
--   6. The owner's links of 12 November 2026 for the sheet's other sites, and
--      the HW/TW sensors for the two shared addresses.
--
-- Idempotent and forward-only, per db/README.md.

-- ── 1. The index ─────────────────────────────────────────────────────────────
drop index if exists meganet.station_alert2_unique_idx;
-- And any other unique index on the column, by whatever name it was built.
do $$
declare
  v_ix text;
begin
  for v_ix in
    select i.relname
      from pg_catalog.pg_index x
      join pg_catalog.pg_class i on i.oid = x.indexrelid
      join pg_catalog.pg_attribute a on a.attrelid = x.indrelid and a.attnum = any (x.indkey)
     where x.indrelid = 'meganet.station'::regclass and x.indisunique and not x.indisprimary
       and a.attname = 'alert2_station_id'
  loop
    execute pg_catalog.format('drop index if exists meganet.%I', v_ix);
  end loop;
end
$$;
create index if not exists station_alert2_idx
  on meganet.station (alert2_station_id)
  where alert2_station_id is not null and deleted_at is null;
comment on column meganet.station.alert2_station_id is
  'The ALERT2 source address of the station this row is, when its readings arrive relayed over ALERT2. Since 0121 stations at one site may share one, told apart by their sensors'' ALERT2 slots (sensor.alert2_sensor_id).';

-- ── 2. Address and slot ──────────────────────────────────────────────────────
create or replace function meganet.resolve_a2_sensor(p_a2_station integer, p_a2_sensor integer)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with h as (
    select st.id from meganet.station st
     where p_a2_station is not null and st.deleted_at is null and st.alert2_station_id = p_a2_station
  )
  select case
    when (select pg_catalog.count(*) from h) = 1 then (select pg_catalog.min(h.id) from h)
    else (select case when pg_catalog.count(distinct se.station_id) = 1 then pg_catalog.min(se.station_id) end
            from meganet.sensor se
           where p_a2_sensor is not null and se.alert2_sensor_id = p_a2_sensor
             and se.station_id in (select h.id from h))
  end;
$$;
comment on function meganet.resolve_a2_sensor(integer, integer) is
  'Which station is this ALERT2 reading (0121)? The only station holding the address; else, among several at one site, the one whose sensor carries the slot; else null.';
revoke all on function meganet.resolve_a2_sensor(integer, integer) from public;
grant execute on function meganet.resolve_a2_sensor(integer, integer) to anon, authenticated, service_role;

-- ── 3 and 4. ingest(), resolve_readings(), save_station() ────────────────────
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
      v_station := coalesce(meganet.resolve_a2_sensor(v_a2_stn, v_a2_sen),
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

create or replace function meganet.resolve_readings(p_max_rows integer default 100000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write readings' using errcode = '42501';
  end if;

  with candidates as (
    select r.ctid,
           coalesce(meganet.resolve_a2_sensor(r.a2_station, r.a2_sensor),
                    meganet.resolve_station(r.alert_id, r.station_number)) as sid
      from meganet.reading r
     where r.station_id is null
     limit greatest(p_max_rows, 0)
  )
  update meganet.reading r
     set station_id = c.sid
    from candidates c
   where r.ctid = c.ctid and c.sid is not null;

  get diagnostics v_n = row_count;

  return pg_catalog.jsonb_build_object(
    'resolved', v_n,
    'unresolved', (select pg_catalog.count(*) from meganet.reading where station_id is null));
end;
$$;

create or replace function meganet.save_station(
         p_doc jsonb,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       text := p_doc ->> 'id';
  v_actor    text := meganet.actor();
  v_is_new   boolean;
  v_prev     timestamptz;
  v_ord      integer;
  v_rep      jsonb := p_doc -> 'repeater';
  v_delay    integer;
  v_a2       integer;
  v_dup_a2   integer;
  v_sensors  jsonb;
  v_ranges   jsonb;
  v_deleted  timestamptz;
  v_saved    jsonb;
  v_now      timestamptz;
  v_key      text;
  v_bad      text;
  v_proposed boolean;
  v_type     text;
  v_year     integer;
  v_tower    numeric;
  v_from     text;
  v_facing   numeric;
  v_was      boolean;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write to the station list'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see #B8';
  end if;

  if v_id is null or v_id = '' then
    raise exception 'the station has no id' using errcode = '22023';
  end if;
  if coalesce(p_doc ->> 'name', '') = '' then
    raise exception 'a station needs a name' using errcode = '22023';
  end if;
  if jsonb_typeof(p_doc -> 'roles') is distinct from 'array' then
    raise exception 'roles must be an array' using errcode = '22023';
  end if;
  -- Checked here rather than left to the foreign key so a stale pick-list gets
  -- an answer about the form, not about a constraint name.
  if nullif(p_doc ->> 'inspection_config_key', '') is not null
     and not exists (select 1 from meganet.inspection_config c
                      where c.key = p_doc ->> 'inspection_config_key') then
    raise exception 'unknown inspection configuration "%"', p_doc ->> 'inspection_config_key'
      using errcode = '22023',
            hint    = 'the telemetry-type list comes from meganet.inspection_config — reload and pick again';
  end if;
  -- Same manners for the repeater delay: the check constraint would refuse it
  -- anyway, but with a constraint name rather than a sentence.
  if v_rep is not null and jsonb_typeof(v_rep) = 'object' then
    v_delay := (v_rep ->> 'delay_ms')::integer;
    if v_delay is not null and (v_delay < 0 or v_delay > 9999) then
      raise exception 'repeater delay must be between 0 and 9999 ms, not %', v_delay
        using errcode = '22023';
    end if;
  end if;

  -- And for the ALERT2 address, which has two ways of being wrong that the
  -- indexes would otherwise report by name: out of range, and already somebody
  -- else's. The second is the one worth a sentence — the person typing it has no
  -- other way to find out who holds it.
  v_a2 := nullif(p_doc ->> 'alert2_station_id', '')::integer;
  if v_a2 is not null and (v_a2 < 1 or v_a2 > 65535) then
    raise exception 'an ALERT2 station address is 1-65535, not %', v_a2
      using errcode = '22023';
  end if;
  -- Since 0121 an address may be shared by stations at one site — a weir's
  -- headwater and tailwater gauges on one logger — told apart by the slot
  -- (sensor number) each station's sensors carry. So sharing is allowed when
  -- this station names at least one slot, and none of its slots is one another
  -- holder names; otherwise a reading could not say whose it is.
  if v_a2 is not null and exists (
       select 1 from meganet.station st
        where st.alert2_station_id = v_a2 and st.deleted_at is null and st.id <> v_id) then
    if not exists (
         select 1 from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb)) x
          where nullif(x.value ->> 'alert2_sensor_id', '') is not null) then
      raise exception 'ALERT2 station address % already belongs to %', v_a2,
        (select pg_catalog.string_agg(st.name, ', ' order by st.name) from meganet.station st
          where st.alert2_station_id = v_a2 and st.deleted_at is null and st.id <> v_id)
        using errcode = '22023',
              hint    = 'to share it, give this station''s sensors their ALERT2 slots (the sensor numbers it sends), different from the other station''s';
    end if;
    select (x.value ->> 'alert2_sensor_id')::integer into v_dup_a2
      from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb)) x
     where nullif(x.value ->> 'alert2_sensor_id', '') is not null
       and exists (select 1 from meganet.sensor se join meganet.station st on st.id = se.station_id
                    where st.alert2_station_id = v_a2 and st.deleted_at is null and st.id <> v_id
                      and se.alert2_sensor_id = (x.value ->> 'alert2_sensor_id')::integer)
     limit 1;
    if v_dup_a2 is not null then
      raise exception 'ALERT2 slot % of address % is already another station''s sensor', v_dup_a2, v_a2
        using errcode = '22023',
              hint    = 'one sensor number of one address is one instrument: change it there first';
    end if;
    v_dup_a2 := null;
  end if;

  -- Two sensor rows claiming one slot is the same ambiguity one level down.
  select (x.value ->> 'alert2_sensor_id')::integer into v_dup_a2
    from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb)) x
   where nullif(x.value ->> 'alert2_sensor_id', '') is not null
   group by (x.value ->> 'alert2_sensor_id')::integer
  having count(*) > 1
   limit 1;
  if v_dup_a2 is not null then
    raise exception 'two sensors are both ALERT2 slot % — a slot is one instrument', v_dup_a2
      using errcode = '22023';
  end if;

  -- The lists 0031 and 0032 added. Each is a list when it is there at all, and
  -- the codes in it are ones the vocabularies know — asked here, before anything
  -- is written, so a code nobody knows gets a sentence naming it rather than a
  -- foreign key's name.
  foreach v_key in array array['flood_classes', 'crossings', 'gauge_survey',
                               'bureau_listings', 'flood_effects',
                               'aep_levels', 'frequencies'] loop
    if p_doc ? v_key and jsonb_typeof(p_doc -> v_key) is distinct from 'array' then
      raise exception '% must be a list', v_key using errcode = '22023';
    end if;
  end loop;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'crossing_type'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'flood_classes') = 'array'
                                           then p_doc -> 'flood_classes' else '[]'::jsonb end) x
          union all
          select nullif(btrim(x.value ->> 'crossing_type'), '')
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'crossings') = 'array'
                                           then p_doc -> 'crossings' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.crossing_type t where t.code = c.code);
  if v_bad is not null then
    raise exception 'unknown crossing type %', v_bad
      using errcode = '22023',
            hint    = 'the crossing types are the Bureau''s legend, in meganet.crossing_type';
  end if;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'datum'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'gauge_survey') = 'array'
                                           then p_doc -> 'gauge_survey' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.gauge_datum d where d.code = c.code);
  if v_bad is not null then
    raise exception 'unknown datum %', v_bad
      using errcode = '22023',
            hint    = 'the datums a gauge zero may be in are meganet.gauge_datum';
  end if;

  -- The two lists 0033 added, asked the same way: a sentence naming what is
  -- wrong rather than a check constraint's name. The editor offers only the
  -- values these accept, so a refusal here is a stale tab or a hand-made
  -- document.
  select string_agg(distinct msg, '; ') into v_bad
    from (select case
                   when nullif(btrim(x.value ->> 'setting'), '') is not null
                    and btrim(x.value ->> 'setting') not in ('channel', 'floodplain')
                     then format('setting %L is neither channel nor floodplain', x.value ->> 'setting')
                   when nullif(x.value ->> 'data_quality', '')::numeric not between 1 and 3
                     then format('data quality %s is not 1–3', x.value ->> 'data_quality')
                   when nullif(x.value ->> 'level_difference', '')::numeric not between 1 and 3
                     then format('level difference %s is not 1–3', x.value ->> 'level_difference')
                   when nullif(x.value ->> 'confidence', '')::numeric not between 1 and 9
                     then format('confidence %s is not 1–9', x.value ->> 'confidence')
                   when nullif(x.value ->> 'slope', '')::numeric < 0
                     then format('slope %s is below zero', x.value ->> 'slope')
                   when nullif(x.value ->> 'manning_n', '')::numeric not between 0.01 and 0.3
                     then format('Manning n %s is outside 0.01–0.3', x.value ->> 'manning_n')
                 end as msg
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'aep_levels') = 'array'
                                           then p_doc -> 'aep_levels' else '[]'::jsonb end) x
          union all
          select case
                   when nullif(x.value ->> 'rx_mhz', '')::numeric <= 0
                     or nullif(x.value ->> 'tx_mhz', '')::numeric <= 0
                     then 'a frequency is a positive number of MHz'
                 end
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'frequencies') = 'array'
                                           then p_doc -> 'frequencies' else '[]'::jsonb end) x) c
   where msg is not null;
  if v_bad is not null then
    raise exception 'not saved: %', v_bad using errcode = '22023';
  end if;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'section'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'bureau_listings') = 'array'
                                           then p_doc -> 'bureau_listings' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.bureau_index b where b.code = c.code);
  if v_bad is not null then
    raise exception 'unknown Bureau index section %', v_bad
      using errcode = '22023',
            hint    = 'the indexes a station can be listed in are meganet.bureau_index — Sections 1, 2 and 3';
  end if;
  -- A listing that says something, but not which index: refused rather than
  -- dropped, because somebody typed the date or the note meaning to keep it.
  if exists (select 1
               from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'bureau_listings') = 'array'
                                              then p_doc -> 'bureau_listings' else '[]'::jsonb end) x
              where nullif(btrim(x.value ->> 'section'), '') is null
                and num_nonnulls(nullif(x.value ->> 'as_at', ''),
                                 nullif(btrim(x.value ->> 'note'), '')) > 0) then
    raise exception 'a Bureau index listing needs the section it is listed in'
      using errcode = '22023',
            hint    = 'pick Section 1, 2 or 3 for the row, or remove it';
  end if;

  -- The tower's platform height (0040): one of the standard drawing's two,
  -- 3.0 m or 4.5 m, or absent. Asked before anything is written, in a sentence
  -- rather than the column's check.
  if jsonb_typeof(p_doc -> 'tower_height') not in ('number', 'string', 'null') then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not %', p_doc -> 'tower_height'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_doc ->> 'tower_height'), '') is not null
     and btrim(p_doc ->> 'tower_height') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not "%"', p_doc ->> 'tower_height'
      using errcode = '22023';
  end if;
  v_tower := nullif(btrim(p_doc ->> 'tower_height'), '')::numeric;
  if v_tower is not null and v_tower not in (3.0, 4.5) then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not %', v_tower
      using errcode = '22023',
            hint    = 'the standard drawing''s two platform heights, each on a 2100 × 2100 footing';
  end if;

  -- The station it takes its flood history from (0041): another live station,
  -- or absent.
  if jsonb_typeof(p_doc -> 'flood_peaks_from') not in ('string', 'null') then
    raise exception 'flood_peaks_from is a station''s id, not %', p_doc -> 'flood_peaks_from'
      using errcode = '22023';
  end if;
  v_from := nullif(btrim(p_doc ->> 'flood_peaks_from'), '');
  if v_from is not null and v_from = v_id then
    raise exception 'a station cannot take its flood history from itself'
      using errcode = '22023';
  end if;
  if v_from is not null
     and not exists (select 1 from meganet.station s where s.id = v_from and s.deleted_at is null) then
    raise exception 'there is no station "%" to take the flood history from', v_from
      using errcode = '22023',
            hint    = 'name it by its id, such as gatton';
  end if;

  -- The way the station faces (0044): a bearing in whole or part degrees,
  -- 0 up to but not 360, or absent. 360 is read as 0 rather than refused.
  if jsonb_typeof(p_doc -> 'facing_deg') not in ('number', 'string', 'null') then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not %', p_doc -> 'facing_deg'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_doc ->> 'facing_deg'), '') is not null
     and btrim(p_doc ->> 'facing_deg') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not "%"', p_doc ->> 'facing_deg'
      using errcode = '22023';
  end if;
  v_facing := round(nullif(btrim(p_doc ->> 'facing_deg'), '')::numeric, 1);
  if v_facing = 360 then v_facing := 0; end if;
  if v_facing is not null and (v_facing < 0 or v_facing >= 360) then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not %', v_facing
      using errcode = '22023',
            hint    = 'clockwise from true north: 0 north, 90 east, 180 south, 270 west';
  end if;

  -- The proposal (0039), asked before anything is written, like the lists
  -- above: `proposed` is true or false when it is there at all, the type is one
  -- meganet.station_type knows, and the year is four figures a person could
  -- mean. A proposal carries all three things that make it one — what kind of
  -- station, the year it is proposed for, and where it would go — and each
  -- missing one is refused with its own sentence rather than the constraint's.
  if jsonb_typeof(p_doc -> 'proposed') not in ('boolean', 'null') then
    raise exception 'proposed is true or false, not %', p_doc -> 'proposed'
      using errcode = '22023';
  end if;
  v_proposed := coalesce((p_doc ->> 'proposed')::boolean, false);
  v_type := nullif(btrim(p_doc ->> 'station_type'), '');
  if v_type is not null
     and not exists (select 1 from meganet.station_type t where t.code = v_type) then
    raise exception 'unknown station type "%"', v_type
      using errcode = '22023',
            hint    = 'the types are meganet.station_type: an automatic or manual water level station, an automatic or manual rain gauge';
  end if;
  if nullif(btrim(p_doc ->> 'proposed_year'), '') is not null
     and btrim(p_doc ->> 'proposed_year') !~ '^[0-9]{4}$' then
    raise exception 'the year a station is proposed for is a year, such as 2026 — not "%"', p_doc ->> 'proposed_year'
      using errcode = '22023';
  end if;
  v_year := nullif(btrim(p_doc ->> 'proposed_year'), '')::integer;
  if v_year is not null and (v_year < 1900 or v_year > 2200) then
    raise exception 'the year a station is proposed for is between 1900 and 2200, not %', v_year
      using errcode = '22023';
  end if;
  if v_proposed then
    if v_type is null then
      raise exception 'a proposed station needs its type: an automatic or manual water level station, or an automatic or manual rain gauge'
        using errcode = '22023';
    end if;
    if v_year is null then
      raise exception 'a proposed station needs the year it is proposed for'
        using errcode = '22023';
    end if;
    if nullif(p_doc ->> 'lat', '') is null or nullif(p_doc ->> 'lon', '') is null then
      raise exception 'a proposed station needs a position: where it is proposed to go'
        using errcode = '22023',
              hint    = 'type its latitude and longitude, or pick the point on the map with What is here';
    end if;
  end if;

  -- Lock the row before reading its stamp, so the check below and the write
  -- after it see the same version. Without the lock two saves can both read the
  -- stamp they expect and both proceed.
  select updated_at, deleted_at, proposed into v_prev, v_deleted, v_was
    from meganet.station where id = v_id for update;
  v_is_new := not found;

  if v_is_new then
    if p_expected_updated_at is not null then
      raise exception 'station "%" is no longer in the database — it was deleted while you had it open', v_id
        using errcode = 'PT409',
              hint    = 'your edits are still on screen; copy anything you need, then reload';
    end if;
  else
    if p_expected_updated_at is null then
      raise exception 'this editor did not load station "%" from the database, so it will not overwrite it', v_id
        using errcode = 'PT409',
              hint    = 'reload from the datastore and open the station again';
    end if;
    if v_prev is distinct from p_expected_updated_at then
      raise exception 'station "%" was changed in the database at %, after you opened it', v_id, v_prev
        using errcode = 'PT409',
              hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
    end if;
  end if;

  -- Who may add a station, and who may establish one (0039). A new station
  -- that is not a proposal is a station added outright; a flag that changes on
  -- a station already here is a proposal established, or an established
  -- station taken back to proposed. All three are an administrator's
  -- (is_admin(), 0036, which says yes to the service role and to a direct
  -- connection). Anybody who may edit may propose one and edit a proposal.
  -- After the stamp checks, so a stale tab hears that first. The detail line is
  -- what tells this refusal from 42501's other meaning, "not on the editors
  -- list", which asks for something different of the person reading it.
  if not meganet.is_admin() then
    if v_is_new and not v_proposed then
      raise exception 'only an administrator adds a station outright — save it as a proposed station, and an administrator establishes it'
        using errcode = '42501',
              detail  = 'administrator',
              hint    = 'tick Proposed, give it a type and a year, and save again';
    end if;
    if not v_is_new and v_was is distinct from v_proposed then
      raise exception '%', case when v_was
                                then 'only an administrator establishes a proposed station'
                                else 'only an administrator takes an established station back to proposed' end
        using errcode = '42501',
              detail  = 'administrator';
    end if;
  end if;

  -- Gauge zero is an administrator's (0060). The rows' dates, gauge zeros and
  -- datums, as a set, must come out as the station has them; the AMTD, the
  -- catchment area and the note are anybody's who may edit. Rows with neither
  -- a gauge zero nor a datum say nothing about a level and are left out of it.
  if p_doc ? 'gauge_survey' and not meganet.is_admin() then
    if coalesce((select pg_catalog.string_agg(pg_catalog.format('%s|%s|%s|%s', g.valid_from, g.valid_to,
                                                                pg_catalog.trim_scale(g.gauge_zero_m), g.datum), ';'
                                              order by g.valid_from nulls first, g.valid_to nulls first,
                                                       g.gauge_zero_m nulls first, g.datum nulls first)
                   from meganet.station_gauge_survey g
                  where g.station_id = v_id and (g.gauge_zero_m is not null or g.datum is not null)), '')
       is distinct from
       coalesce((select pg_catalog.string_agg(pg_catalog.format('%s|%s|%s|%s', r.valid_from, r.valid_to,
                                                                pg_catalog.trim_scale(r.gauge_zero_m), r.datum), ';'
                                              order by r.valid_from nulls first, r.valid_to nulls first,
                                                       r.gauge_zero_m nulls first, r.datum nulls first)
                   from (select nullif(x.value ->> 'valid_from', '')::date              as valid_from,
                                nullif(x.value ->> 'valid_to', '')::date                as valid_to,
                                nullif(x.value ->> 'gauge_zero_m', '')::numeric         as gauge_zero_m,
                                nullif(pg_catalog.btrim(x.value ->> 'datum'), '')       as datum
                           from pg_catalog.jsonb_array_elements(p_doc -> 'gauge_survey') x(value)) r
                  where r.gauge_zero_m is not null or r.datum is not null), '') then
      raise exception 'only an administrator changes a station''s gauge zero, its datum or the dates it applies between'
        using errcode = '42501',
              detail  = 'administrator',
              hint    = 'record it in a level survey on the Level Survey tab, and an administrator applies it — the AMTD, catchment area and notes are still yours to edit';
    end if;
  end if;

  -- Position in the document. An existing station keeps its place; a new one
  -- goes on the end, which is where an appended station lands in the file too.
  if v_is_new then
    select coalesce(max(ord), -1) + 1 into v_ord from meganet.station;
  else
    select ord into v_ord from meganet.station where id = v_id;
  end if;

  insert into meganet.station (
    id, ord, name, station_number, lat, lon, elevation_ahd, elevation_source, owner,
    roles, radio_network_ids, catchment_ids, alert_ids, satcom,
    rm_system_id, enabled, notes, legacy_unit_id, site, lga, basin,
    location_types, tbrg_bucket_size, inspection_config_key,
    alert2_station_id, awrc_number, stream, urbs_label, proposed, station_type,
    proposed_year, tower_height, flood_peaks_from, facing_deg, deleted_at, updated_by)
  values (
    v_id, v_ord,
    p_doc ->> 'name',
    coalesce(p_doc ->> 'station_number', ''),
    (p_doc ->> 'lat')::numeric,
    (p_doc ->> 'lon')::numeric,
    (p_doc ->> 'elevation_ahd')::numeric,
    p_doc ->> 'elevation_source',
    nullif(btrim(p_doc ->> 'owner'), ''),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'roles') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'radio_network_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'catchment_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce(p_doc -> 'alert_ids', '{}'::jsonb),
    coalesce(p_doc -> 'satcom', '{}'::jsonb),
    -- Not coalesced to 1 any more. 0022 made this column nullable because the
    -- bench gateway has no radio system and meganet.rm_system is empty until
    -- load_stations_doc() fills it — but save_station() went on defaulting a
    -- missing value to 1, which fails the foreign key outright on a database
    -- built from zero and, on a database that has rm_system 1, quietly writes it
    -- over the null 0022 had just made legal. Half of that fix was missing.
    nullif(p_doc ->> 'rm_system_id', '')::integer,
    coalesce((p_doc ->> 'enabled')::boolean, true),
    coalesce(p_doc ->> 'notes', ''),
    (p_doc ->> 'legacy_unit_id')::integer,
    p_doc -> 'site',
    p_doc ->> 'lga',
    p_doc ->> 'basin',
    (select array_agg(v order by o)
       from jsonb_array_elements_text(p_doc -> 'location_types') with ordinality t(v, o)),
    (p_doc ->> 'TBRGbucketSize')::numeric,
    nullif(p_doc ->> 'inspection_config_key', ''),
    -- Empty stays null. 0022 made rm_system_id nullable and the form promptly
    -- wrote 1 over every null it found, because `parseInt('') || 1` is 1; this
    -- column gets no such default, here or in the form.
    v_a2,
    -- 0032's three: a blank one is null, so the view's absent-rather-than-null
    -- shape holds whichever way a row arrived.
    nullif(btrim(p_doc ->> 'awrc_number'), ''),
    nullif(btrim(p_doc ->> 'stream'), ''),
    nullif(btrim(p_doc ->> 'urbs_label'), ''),
    -- 0039's three, as asked above.
    v_proposed, v_type, v_year,
    -- 0040's, 0041's and 0044's, as asked above.
    v_tower, v_from, v_facing,
    -- Saving a station that had been deleted brings it back. The alternative is
    -- refusing the save of a station the editor is looking at, which would be a
    -- puzzle rather than a safeguard.
    null,
    v_actor)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon,
         elevation_ahd = excluded.elevation_ahd,
         elevation_source = excluded.elevation_source, owner = excluded.owner,
         roles = excluded.roles,
         radio_network_ids = excluded.radio_network_ids,
         catchment_ids = excluded.catchment_ids, alert_ids = excluded.alert_ids,
         satcom = excluded.satcom, rm_system_id = excluded.rm_system_id,
         enabled = excluded.enabled, notes = excluded.notes,
         legacy_unit_id = excluded.legacy_unit_id, site = excluded.site,
         lga = excluded.lga, basin = excluded.basin,
         location_types = excluded.location_types,
         tbrg_bucket_size = excluded.tbrg_bucket_size,
         inspection_config_key = excluded.inspection_config_key,
         alert2_station_id = excluded.alert2_station_id,
         awrc_number = excluded.awrc_number, stream = excluded.stream,
         urbs_label = excluded.urbs_label,
         proposed = excluded.proposed, station_type = excluded.station_type,
         proposed_year = excluded.proposed_year,
         tower_height = excluded.tower_height,
         flood_peaks_from = excluded.flood_peaks_from,
         facing_deg = excluded.facing_deg,
         deleted_at = null, updated_by = excluded.updated_by;

  -- ── sensors ───────────────────────────────────────────────────────────────
  -- Normalised into a variable first, because the delete and the insert below
  -- both need the same list and a CTE cannot span two statements.
  --
  -- The natural key is (station_id, sensor_id, type), and a row the operator
  -- typed by hand has no sensor_id — those come from ARRO's export. One is
  -- minted from the station and, in order of preference, the ALERT address, the
  -- ALERT2 slot, or the row's position. The order matters: position is the only
  -- one of the three that changes when the form is reordered, so it is the last
  -- resort rather than the second.
  --
  -- `distinct on` because two rows with the same address and type are the same
  -- sensor typed twice, and ON CONFLICT refuses to touch one row twice in a
  -- statement — a duplicate would otherwise fail the whole save with an error
  -- about the query rather than about the form.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sensor_id', sensor_id, 'type', type, 'ord', ord,
           'alert_id', alert_id, 'device_id', device_id,
           'alert2_sensor_id', alert2_sensor_id) order by ord), '[]'::jsonb)
    into v_sensors
    from (
      select distinct on (sensor_id, type) sensor_id, type, ord, alert_id, device_id,
             alert2_sensor_id
        from (
          select coalesce(nullif(x.value ->> 'sensor_id', ''),
                          v_id || ':' || coalesce(
                            x.value ->> 'alert_id',
                            case when nullif(x.value ->> 'alert2_sensor_id', '') is not null
                                 then 'a2:' || (x.value ->> 'alert2_sensor_id') end,
                            (x.ord - 1)::text))                                       as sensor_id,
                 coalesce(nullif(x.value ->> 'type', ''), 'Unknown')                  as type,
                 (x.ord - 1)::integer                                                 as ord,
                 (x.value ->> 'alert_id')::integer                                    as alert_id,
                 (x.value ->> 'device_id')::integer                                   as device_id,
                 nullif(x.value ->> 'alert2_sensor_id', '')::integer                  as alert2_sensor_id
            from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb))
                 with ordinality x(value, ord)
        ) raw
       order by sensor_id, type, ord
    ) uniq;

  delete from meganet.sensor t
   where t.station_id = v_id
     and not exists (select 1 from jsonb_array_elements(v_sensors) e
                      where e.value ->> 'sensor_id' = t.sensor_id
                        and e.value ->> 'type'      = t.type);

  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, device_id,
                              alert2_sensor_id, updated_by)
  select v_id, e.value ->> 'sensor_id', e.value ->> 'type', (e.value ->> 'ord')::integer,
         (e.value ->> 'alert_id')::integer, (e.value ->> 'device_id')::integer,
         (e.value ->> 'alert2_sensor_id')::integer, v_actor
    from jsonb_array_elements(v_sensors) e
  on conflict (station_id, sensor_id, type) do update
     set ord = excluded.ord, alert_id = excluded.alert_id,
         device_id = excluded.device_id,
         alert2_sensor_id = excluded.alert2_sensor_id,
         updated_by = excluded.updated_by
   where (meganet.sensor.ord, meganet.sensor.alert_id, meganet.sensor.device_id,
          meganet.sensor.alert2_sensor_id)
      is distinct from (excluded.ord, excluded.alert_id, excluded.device_id,
                        excluded.alert2_sensor_id);

  -- ── repeater and its ranges ───────────────────────────────────────────────
  -- The role is what decides, not the presence of the object: un-ticking
  -- "repeater" in the editor has to remove the repeater detail, or a station
  -- keeps passing addresses it is no longer a repeater for.
  if v_rep is null or jsonb_typeof(v_rep) is distinct from 'object'
     or not (coalesce(p_doc -> 'roles', '[]'::jsonb) ? 'repeater') then
    -- Cascades to pass_range.
    delete from meganet.repeater where station_id = v_id;
  else
    insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, delay_ms, notes, updated_by)
    values (v_id, coalesce(v_rep ->> 'acma_licence', ''),
            (v_rep ->> 'rx_mhz')::numeric, (v_rep ->> 'tx_mhz')::numeric,
            v_delay,
            coalesce(v_rep ->> 'notes', ''), v_actor)
    on conflict (station_id) do update
       set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
           tx_mhz = excluded.tx_mhz, delay_ms = excluded.delay_ms,
           notes = excluded.notes, updated_by = excluded.updated_by;

    -- Ranges are replaced wholesale rather than diffed. There are ten of them on
    -- a busy repeater, they have no identity beyond their own numbers, and the
    -- editor hands over a textarea — "these are the ranges now" is what it means
    -- and what this does. Duplicated lines collapse: (kind, lo, hi) is the key.
    select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'lo', lo, 'hi', hi, 'ord', ord)
                              order by ord), '[]'::jsonb)
      into v_ranges
      from (
        select distinct on (kind, lo, hi) kind, lo, hi, ord
          from (
            select k.kind,
                   (p.value ->> 'low')::integer  as lo,
                   (p.value ->> 'high')::integer as hi,
                   (p.ord - 1)::integer          as ord
              from (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions')) as k(kind, field)
              cross join lateral jsonb_array_elements(coalesce(v_rep -> k.field, '[]'::jsonb))
                         with ordinality p(value, ord)
             where (p.value ->> 'low') is not null and (p.value ->> 'high') is not null
          ) raw
         order by kind, lo, hi, ord
      ) uniq;

    delete from meganet.pass_range where repeater_id = v_id;

    insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by)
    select v_id, e.value ->> 'kind', (e.value ->> 'lo')::integer,
           (e.value ->> 'hi')::integer, (e.value ->> 'ord')::integer, v_actor
      from jsonb_array_elements(v_ranges) e;
  end if;

  -- ── flood classes, crossings, gauge survey (0031) ─────────────────────────
  -- Each list the editor sends is "these are the rows now", so it replaces what
  -- is there, the way the pass ranges above are replaced. A list that is not in
  -- the document at all is left exactly as it is — see the head of 0031 for why
  -- that differs from the sensors. Blank rows are dropped rather than refused: an
  -- editor's "+ Add" row left empty is not something anybody meant to save. What
  -- survives is renumbered from 0, so `ord` stays the list's own order.
  if p_doc ? 'flood_classes' then
    delete from meganet.station_flood_class where station_id = v_id;
    insert into meganet.station_flood_class (
      station_id, ord, as_at, first_report_m, crossing_height_m, crossing_type,
      minor_m, crops_grazing_m, moderate_m, towns_m, major_m, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.first_report_m, r.crossing_height_m, r.crossing_type,
           r.minor_m, r.crops_grazing_m, r.moderate_m, r.towns_m, r.major_m, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                   as as_at,
               nullif(x.value ->> 'first_report_m', '')::numeric       as first_report_m,
               nullif(x.value ->> 'crossing_height_m', '')::numeric    as crossing_height_m,
               nullif(btrim(x.value ->> 'crossing_type'), '')          as crossing_type,
               nullif(x.value ->> 'minor_m', '')::numeric              as minor_m,
               nullif(x.value ->> 'crops_grazing_m', '')::numeric      as crops_grazing_m,
               nullif(x.value ->> 'moderate_m', '')::numeric           as moderate_m,
               nullif(x.value ->> 'towns_m', '')::numeric              as towns_m,
               nullif(x.value ->> 'major_m', '')::numeric              as major_m,
               nullif(btrim(x.value ->> 'note'), '')                   as note
          from jsonb_array_elements(p_doc -> 'flood_classes') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.first_report_m, r.crossing_height_m, r.crossing_type, r.minor_m,
                        r.crops_grazing_m, r.moderate_m, r.towns_m, r.major_m, r.note) > 0;
  end if;

  if p_doc ? 'crossings' then
    delete from meganet.station_crossing where station_id = v_id;
    insert into meganet.station_crossing (
      station_id, ord, as_at, stream, name, height_m, crossing_type, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.stream, r.name, r.height_m, r.crossing_type, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                as as_at,
               nullif(btrim(x.value ->> 'stream'), '')              as stream,
               nullif(btrim(x.value ->> 'name'), '')                as name,
               nullif(x.value ->> 'height_m', '')::numeric          as height_m,
               nullif(btrim(x.value ->> 'crossing_type'), '')       as crossing_type,
               nullif(btrim(x.value ->> 'note'), '')                as note
          from jsonb_array_elements(p_doc -> 'crossings') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.stream, r.name, r.height_m, r.crossing_type, r.note) > 0;
  end if;

  if p_doc ? 'gauge_survey' then
    delete from meganet.station_gauge_survey where station_id = v_id;
    insert into meganet.station_gauge_survey (
      station_id, ord, valid_from, valid_to, gauge_zero_m, datum, amtd_km,
      catchment_area_km2, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.valid_from, r.valid_to, r.gauge_zero_m, r.datum, r.amtd_km,
           r.catchment_area_km2, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'valid_from', '')::date                as valid_from,
               nullif(x.value ->> 'valid_to', '')::date                  as valid_to,
               nullif(x.value ->> 'gauge_zero_m', '')::numeric           as gauge_zero_m,
               nullif(btrim(x.value ->> 'datum'), '')                    as datum,
               nullif(x.value ->> 'amtd_km', '')::numeric                as amtd_km,
               nullif(x.value ->> 'catchment_area_km2', '')::numeric     as catchment_area_km2,
               nullif(btrim(x.value ->> 'note'), '')                     as note
          from jsonb_array_elements(p_doc -> 'gauge_survey') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.gauge_zero_m, r.datum, r.amtd_km, r.catchment_area_km2, r.note) > 0;
  end if;

  -- ── index listings, flood effects (0032) ─────────────────────────────────
  -- 0031's rule for 0031's lists: present replaces, absent leaves alone, blank
  -- rows go, and what is left is renumbered from 0.
  if p_doc ? 'bureau_listings' then
    delete from meganet.station_bureau_listing where station_id = v_id;
    insert into meganet.station_bureau_listing (
      station_id, ord, section, as_at, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.section, r.as_at, r.note, v_actor
      from (
        select x.ord,
               nullif(btrim(x.value ->> 'section'), '')        as section,
               nullif(x.value ->> 'as_at', '')::date           as as_at,
               nullif(btrim(x.value ->> 'note'), '')           as note
          from jsonb_array_elements(p_doc -> 'bureau_listings') with ordinality x(value, ord)
      ) r
     where r.section is not null;
  end if;

  if p_doc ? 'flood_effects' then
    delete from meganet.station_flood_effect where station_id = v_id;
    insert into meganet.station_flood_effect (
      station_id, ord, as_at, height_m, effect, detail, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.height_m, r.effect, r.detail, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date           as as_at,
               nullif(x.value ->> 'height_m', '')::numeric     as height_m,
               nullif(btrim(x.value ->> 'effect'), '')         as effect,
               nullif(btrim(x.value ->> 'detail'), '')         as detail,
               nullif(btrim(x.value ->> 'note'), '')           as note
          from jsonb_array_elements(p_doc -> 'flood_effects') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.height_m, r.effect, r.detail, r.note) > 0;
  end if;

  -- ── AEP levels, frequencies (0033) ────────────────────────────────────────
  -- 0031's rule: the list the editor sends replaces what is there, a list it
  -- does not send is left alone, and a blank row is dropped.
  if p_doc ? 'aep_levels' then
    delete from meganet.station_aep_level where station_id = v_id;
    insert into meganet.station_aep_level (
      station_id, ord, as_at, source, point_lat, point_lon, ground_m, aep_1_m,
      aep_0_5_m, aep_0_2_m, aep_0_066_m, data_quality, level_difference, confidence,
      setting, slope, slope_basis, manning_n, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.source, r.point_lat, r.point_lon, r.ground_m, r.aep_1_m,
           r.aep_0_5_m, r.aep_0_2_m, r.aep_0_066_m, r.data_quality, r.level_difference,
           r.confidence, r.setting, r.slope, r.slope_basis, r.manning_n, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                as as_at,
               nullif(btrim(x.value ->> 'source'), '')              as source,
               nullif(x.value ->> 'point_lat', '')::numeric         as point_lat,
               nullif(x.value ->> 'point_lon', '')::numeric         as point_lon,
               nullif(x.value ->> 'ground_m', '')::numeric          as ground_m,
               nullif(x.value ->> 'aep_1_m', '')::numeric           as aep_1_m,
               nullif(x.value ->> 'aep_0_5_m', '')::numeric         as aep_0_5_m,
               nullif(x.value ->> 'aep_0_2_m', '')::numeric         as aep_0_2_m,
               nullif(x.value ->> 'aep_0_066_m', '')::numeric       as aep_0_066_m,
               nullif(x.value ->> 'data_quality', '')::integer      as data_quality,
               nullif(x.value ->> 'level_difference', '')::integer  as level_difference,
               nullif(x.value ->> 'confidence', '')::integer        as confidence,
               nullif(btrim(x.value ->> 'setting'), '')             as setting,
               nullif(x.value ->> 'slope', '')::numeric             as slope,
               nullif(btrim(x.value ->> 'slope_basis'), '')         as slope_basis,
               nullif(x.value ->> 'manning_n', '')::numeric         as manning_n,
               nullif(btrim(x.value ->> 'note'), '')                as note
          from jsonb_array_elements(p_doc -> 'aep_levels') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.ground_m, r.aep_1_m, r.aep_0_5_m, r.aep_0_2_m, r.aep_0_066_m,
                        r.setting, r.slope, r.manning_n, r.note) > 0;
  end if;

  if p_doc ? 'frequencies' then
    delete from meganet.station_frequency where station_id = v_id;
    insert into meganet.station_frequency (
      station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.rx_mhz, r.tx_mhz, r.label, r.acma_licence, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'rx_mhz', '')::numeric        as rx_mhz,
               nullif(x.value ->> 'tx_mhz', '')::numeric        as tx_mhz,
               nullif(btrim(x.value ->> 'label'), '')           as label,
               nullif(btrim(x.value ->> 'acma_licence'), '')    as acma_licence
          from jsonb_array_elements(p_doc -> 'frequencies') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.rx_mhz, r.tx_mhz) > 0;
  end if;

  select updated_at into v_now from meganet.station where id = v_id;
  select doc into v_saved from meganet.station_json where id = v_id;

  return jsonb_build_object(
           'station',    v_saved,
           'updated_at', v_now,
           'created',    v_is_new,
           'updated_by', v_actor);

exception
  -- Two saves racing to create the same id: the loser's insert hits the primary
  -- key rather than the stamp check above, because there was no row to lock.
  -- Same situation, so it gets the same answer.
  when unique_violation then
    raise exception 'station "%" already exists — somebody created it while you were typing', v_id
      using errcode = 'PT409',
            hint    = 'your edits are still on screen; give the station another name or reload';
end;
$$;

-- ── 5. Maleny WWTP ───────────────────────────────────────────────────────────
-- A station no document describes (document_managed false, as 0021's
-- elpro_test), in Maleny AL's catchment, hub and council area.
insert into meganet.station (id, ord, name, lat, lon, roles, catchment_ids, hub_id, lga, basin,
                             notes, document_managed, updated_by)
select 'maleny_wwtp', coalesce((select pg_catalog.max(ord) from meganet.station), 0) + 1, 'Maleny WWTP',
       -26.765182, 152.867250, array['field'], coalesce(m.catchment_ids, '{}'), m.hub_id, m.lga, m.basin,
       'ALERT2 site 8278 on 151.5375 MHz (slots 20 and 20.5 s), from the slot sheet of 12 November 2026. '
       || 'Position from the owner. Not Maleny AL, which is another site.',
       false, '0121'
  from (select 1) one
  left join meganet.station m on m.id = 'maleny_al'
on conflict (id) do nothing;

-- ── 6. Links ─────────────────────────────────────────────────────────────────
-- The slot table's sites to register stations, where 0120 left them unlinked.
-- Only a slot still unlinked is touched, so an editor's later choice stands.
update meganet.tdma_slot t
   set station_id = v.st, updated_at = pg_catalog.now(), updated_by = '0121'
  from (values
    (10019, 'Mt Crosby Rptr',          'mt_crosby_al'),
    (10315, 'Mt Pechey',               'mt_pechey_al'),
    (10134, 'Mt Mee Repeater',         'mt_mee_al_p'),
    (8234,  'Borumba Dam Repeater',    'borumba_dam_hw_al'),
    (11081, 'Cedar Grove',             'cedar_grove_weir_hw_tm'),
    (11047, 'Bromelton Weir HW/TW',    'bromelton_weir_hw_tm'),
    (10184, 'Bill Gun Dam HW (Rptr)',  'bill_gunn_dam_al'),
    (10156, 'Churchbank Weir TW',      'churchbank_weir_tm'),
    (8278,  'Maleny WWTP',             'maleny_wwtp')
  ) as v (a2, site, st)
 where t.alert2_id = v.a2 and t.site = v.site and t.station_id is null
   and exists (select 1 from meganet.station s where s.id = v.st and s.deleted_at is null);
-- Mt Mee RF has slots and no ID on the sheet: the backup gauge.
update meganet.tdma_slot t
   set station_id = 'mt_mee_al_b', updated_at = pg_catalog.now(), updated_by = '0121'
 where t.site = 'Mt Mee RF' and t.alert2_id is null and t.station_id is null
   and exists (select 1 from meganet.station s where s.id = 'mt_mee_al_b' and s.deleted_at is null);

-- Their ALERT2 IDs, on a station with none and an ID nobody holds.
update meganet.station st
   set alert2_station_id = v.a2, updated_by = '0121'
  from (values (10019, 'mt_crosby_al'), (10315, 'mt_pechey_al'), (10134, 'mt_mee_al_p'),
               (8234, 'borumba_dam_hw_al'), (11081, 'cedar_grove_weir_hw_tm'),
               (11047, 'bromelton_weir_hw_tm'), (10184, 'bill_gunn_dam_al'),
               (10156, 'churchbank_weir_tm'), (8278, 'maleny_wwtp')) as v (a2, id)
 where st.id = v.id and st.deleted_at is null and st.alert2_station_id is null
   and not exists (select 1 from meganet.station o where o.alert2_station_id = v.a2 and o.deleted_at is null);

-- The two shared addresses: HW holds sensors 7 (level) and 8 (battery), TW
-- sensor 17 (level), and TW takes the address too. A sensor row is added only
-- where the station has no row carrying that slot.
insert into meganet.sensor (station_id, sensor_id, type, ord, alert2_sensor_id, updated_by)
select v.st, v.sid, v.type,
       coalesce((select pg_catalog.max(x.ord) from meganet.sensor x where x.station_id = v.st), -1) + v.o,
       v.slot, '0121'
  from (values
    ('bromelton_weir_hw_tm',   '540270.a2.7',  'Water Level', 7,  1),
    ('bromelton_weir_hw_tm',   '540270.a2.8',  'Battery',     8,  2),
    ('bromelton_weir_tw_tm',   '540271.a2.17', 'Water Level', 17, 1),
    ('cedar_grove_weir_hw_tm', '540590.a2.7',  'Water Level', 7,  1),
    ('cedar_grove_weir_hw_tm', '540590.a2.8',  'Battery',     8,  2),
    ('cedar_grove_weir_tw_tm', '540748.a2.17', 'Water Level', 17, 1)
  ) as v (st, sid, type, slot, o)
 where exists (select 1 from meganet.station s where s.id = v.st and s.deleted_at is null)
   and not exists (select 1 from meganet.sensor x where x.station_id = v.st and x.alert2_sensor_id = v.slot)
on conflict (station_id, sensor_id, type) do nothing;

update meganet.station st
   set alert2_station_id = v.a2, updated_by = '0121'
  from (values (11047, 'bromelton_weir_tw_tm', 'bromelton_weir_hw_tm'),
               (11081, 'cedar_grove_weir_tw_tm', 'cedar_grove_weir_hw_tm')) as v (a2, id, partner)
 where st.id = v.id and st.deleted_at is null and st.alert2_station_id is null
   and exists (select 1 from meganet.station p where p.id = v.partner and p.alert2_station_id = v.a2 and p.deleted_at is null)
   and exists (select 1 from meganet.sensor se where se.station_id = v.id and se.alert2_sensor_id = 17);

-- ── Did it take ──────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_catalog.pg_indexes where schemaname = 'meganet' and indexname = 'station_alert2_unique_idx') then
    raise exception '0121 did not take: station_alert2_unique_idx is still there';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.ingest(jsonb)'::regprocedure) not like '%resolve_a2_sensor(v_a2_stn, v_a2_sen)%' then
    raise exception '0121 did not take: ingest() does not resolve by address and slot';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.resolve_readings(integer)'::regprocedure) not like '%resolve_a2_sensor%' then
    raise exception '0121 did not take: resolve_readings() does not resolve by address and slot';
  end if;
  if exists (select 1 from meganet.station where id = 'bromelton_weir_hw_tm' and deleted_at is null)
     and exists (select 1 from meganet.station where id = 'bromelton_weir_tw_tm' and deleted_at is null) then
    if meganet.resolve_a2_sensor(11047, 7) is distinct from 'bromelton_weir_hw_tm'
       or meganet.resolve_a2_sensor(11047, 17) is distinct from 'bromelton_weir_tw_tm'
       or meganet.resolve_a2_sensor(11047, 42) is not null then
      raise exception '0121 did not take: 11047 sensors 7 / 17 / 42 resolve to % / % / %',
        meganet.resolve_a2_sensor(11047, 7), meganet.resolve_a2_sensor(11047, 17), meganet.resolve_a2_sensor(11047, 42);
    end if;
  end if;
  if not exists (select 1 from meganet.station where id = 'maleny_wwtp') then
    raise exception '0121 did not take: no Maleny WWTP';
  end if;
end
$$;

-- DB_SCHEMA_VERSION in core.js goes 120 → 121 once this is applied.
insert into meganet.app_meta (key, value)
values ('schema_version', '121')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
