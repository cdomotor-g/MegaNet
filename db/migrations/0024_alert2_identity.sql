-- 0024_alert2_identity.sql — The relayed station is half the address, and it was
-- being thrown away.
--
-- Why this file exists
-- ────────────────────
-- A 115E-2 relaying ALERT2 identifies a reading with a **pair**: the ALERT2
-- station address, and the sensor ID within that station. #169 taught the bridge
-- where both of them live, and then stored only one of them:
--
--   topic: meganet/v1/elpro_test/logger/reading/elpro/Station 1000
--   frame: [{"timestamp":1787529190675,"Sensor":9,"Value":248},
--           {"timestamp":1787529190675,"Sensor":10,"Value":-101}]
--
-- The station address is in the topic tail and nowhere else. `parseElpro()` filed
-- the whole topic as free text in `reading.path` — provenance, deliberately not
-- an identifier — and passed `Sensor` through as `alert_id`, so this message
-- became `a:9` and `a:10`. Three things follow from that, and all three are
-- visible in the live database rather than hypothetical:
--
-- **1 · Two stations, one address.** `Sensor 10` arrives from Station 1000 and
-- from Station 1001. Both were stored as `a:10` — 385 rows, two different
-- instruments, one identity. `Sensor 8` does the same across Stations 1001 and
-- 1002. Nothing was overwritten, because the primary key carries the timestamp
-- too, but nothing can tell them apart either.
--
-- **2 · An address that belongs to somebody else.** Nothing currently owns ALERT
-- addresses 0–20, so these 960 rows resolve to nobody. That is luck. The day
-- anyone adds address 13 to a station, Station 1003's sensor 13 silently becomes
-- their data — and 604 of the 5,122 addresses on file are already shared between
-- stations, which is why resolve_station() refuses to guess in the first place.
--
-- **3 · Sensor 0 was being dropped.** `isAlertId()` accepts 1–65535 because that
-- is the ALERT address range, and zero is not an address. But an ALERT2 sensor ID
-- is a *slot*, not an address: ELPRO's own I/O mapping has four sensor-ID columns
-- and uses **255** for an unused one, so 0 is a real sensor and 255 is the empty
-- marker. Station 1001 has been reporting sensor 0 every cycle since 21 August
-- and not one of those readings exists.
--
-- The obvious repair is not available. `reading.station_number` cannot hold an
-- ALERT2 station address: 87 stations carry four-digit bureau numbers spanning
-- 2009–9997, the ALERT2 source address is a u16, and the two spaces overlap. So
-- the pair needs somewhere of its own to live, and `addr` needs a third shape.
--
-- What this file does *not* do is invent a translation. docs/elpro115e_mqtt.md
-- used to say somebody would have to map each relayed station and sensor to an
-- ALERT address MegaNet would store it under. That prescription is dropped here,
-- for the reason 0006 gives about station_id: a reading is stored as it arrived,
-- and the mapping is a fact about the registry that can be added, corrected or
-- withdrawn later without rewriting a single stored row.
--
-- What changes
-- ────────────
--   1. `station.alert2_station_id` and `sensor.alert2_sensor_id` — the registry
--      can finally say which ALERT2 station and slot a sensor is.
--   2. `reading.a2_station` / `reading.a2_sensor`, and `addr` grows a third
--      shape: `a2:<station>/<sensor>`. This is the only destructive part of the
--      file — `addr` is a stored generated column inside the primary key, and
--      PG16 has no ALTER COLUMN ... SET EXPRESSION, so it is dropped and rebuilt.
--   3. `resolve_a2_station()`, and ingest() / resolve_readings() consult it.
--   4. The 960 rows filed under the wrong address are re-filed under the right
--      one, taking the station address from the topic still stored on each row.
--   5. `meganet.a2_sensor_seen` — what a relayed station has actually sent,
--      whether or not anybody has named it yet.
--   6. `claim_a2_station()` and `claim_alert_address()` — attribute traffic from
--      the Message Log and back-fill every reading that shares the identity, in
--      one transaction.
--   7. station_json / save_station carry the two new fields.
--   8. load_stations_doc() stops deleting sensor rows it did not write, which it
--      would otherwise do to every ALERT2 sensor added through the editor.
--
-- Applying this needs 0022 and 0023 applied first; the live database was still at
-- 21 when this was written, and #171 covers the catch-up.

-- ── The registry learns the ALERT2 pair ──────────────────────────────────────
-- On the station, because the ALERT2 station address identifies the station and
-- nothing smaller. On the sensor, because the slot identifies the instrument
-- within it. This is the same division `station_number` and `sensor.alert_id`
-- already make, one protocol over.

alter table meganet.station
  add column if not exists alert2_station_id integer;

comment on column meganet.station.alert2_station_id is
  'The ALERT2 source address of the station this row is, when its readings arrive relayed over ALERT2. Null for the 3,174 that do not.';

-- Partial, and the same shape as station_number_unique_idx from 0020: an address
-- may be reused after a station is deleted, and two live stations claiming one
-- address is the ambiguity resolve_a2_station() must never have to arbitrate.
create unique index if not exists station_alert2_unique_idx
  on meganet.station (alert2_station_id)
  where alert2_station_id is not null and deleted_at is null;

alter table meganet.sensor
  add column if not exists alert2_sensor_id integer;

comment on column meganet.sensor.alert2_sensor_id is
  'Which of the relayed station''s sensor slots this is. 0-254; ELPRO writes 255 for an unused slot, so 255 is never a sensor.';

alter table meganet.sensor drop constraint if exists sensor_alert2_sensor_range;
alter table meganet.sensor add constraint sensor_alert2_sensor_range check (
  alert2_sensor_id is null or (alert2_sensor_id between 0 and 254));

create unique index if not exists sensor_alert2_unique_idx
  on meganet.sensor (station_id, alert2_sensor_id)
  where alert2_sensor_id is not null;

-- ── meganet.reading carries the pair, and addr grows a third shape ───────────
-- The destructive part, and the only one. `addr` is `generated always as (...)
-- stored` and it is the leading column of the primary key, so a new shape means
-- dropping both and rebuilding them. PostgreSQL 17 could do this in place with
-- ALTER COLUMN ... SET EXPRESSION; CI runs postgres:16, which cannot, and the
-- migration has to pass there before it passes anywhere.
--
-- The cost is bounded and was measured before this was written: 8,345 rows, and
-- reading_hourly and reading_daily are both empty. On a table heading for
-- millions this would want a different plan; today it is a rewrite of eleven
-- pages.
--
-- Guarded on the column rather than on the constraint, because the guard has to
-- hold for a file that is re-run, and by then everything else here exists too.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'meganet' and table_name = 'reading'
       and column_name = 'a2_station') then

    -- Dropping addr takes reading_unresolved_idx with it; it is rebuilt below.
    -- The two indexes 0012 and 0017 added are on other columns and survive.
    alter table meganet.reading drop constraint reading_pkey;
    alter table meganet.reading drop column addr;

    alter table meganet.reading
      add column a2_station integer,
      add column a2_sensor  integer;

    alter table meganet.reading
      add column addr text generated always as (
        case when alert_id   is not null then 'a:'  || alert_id
             when a2_station is not null then 'a2:' || a2_station || '/' || a2_sensor
             else 's:' || coalesce(station_number, '') || '/' || channel
        end) stored;

    alter table meganet.reading add primary key (addr, reading_ts, value_raw);
  end if;
end
$$;

create index if not exists reading_unresolved_idx on meganet.reading
  (addr) where station_id is null;

comment on column meganet.reading.a2_station is
  'The relayed ALERT2 station address. Arrives in the MQTT topic tail and nowhere else, which is why #169 could parse a reading without knowing whose it was.';
comment on column meganet.reading.a2_sensor is
  'Which sensor slot at that ALERT2 station. 0-254 — a slot, not an address, so unlike alert_id zero is real.';
comment on column meganet.reading.addr is
  'The identity. a:<alert address> for radio, a2:<station>/<sensor> for a relayed ALERT2 pair, s:<station number>/<channel> for satellite or cellular. Generated, so it cannot disagree with its parts.';

-- Being addressed now has a third way of being true.
alter table meganet.reading drop constraint if exists reading_addressed;
alter table meganet.reading add constraint reading_addressed check (
  alert_id is not null
  or a2_station is not null
  or nullif(pg_catalog.btrim(station_number), '') is not null);

-- Half a pair is not an address, it is a bug that reached the table.
alter table meganet.reading drop constraint if exists reading_a2_pair;
alter table meganet.reading add constraint reading_a2_pair check (
  (a2_station is null) = (a2_sensor is null));

-- The generated column picks one shape. A row carrying both an ALERT address and
-- an ALERT2 pair has two opinions about what it is, and the same reasoning that
-- gives reading_radio_has_no_channel its existence applies here.
alter table meganet.reading drop constraint if exists reading_a2_not_also_alert;
alter table meganet.reading add constraint reading_a2_not_also_alert check (
  a2_station is null or alert_id is null);

-- The pair is the sensor, so a channel beside it is a second opinion again.
alter table meganet.reading drop constraint if exists reading_a2_has_no_channel;
alter table meganet.reading add constraint reading_a2_has_no_channel check (
  a2_station is null or channel = '');

-- 1-65535 for the station address, matching reading_alert_id_range and for the
-- same reason: the ALERT2 source address is a u16 and zero is not one. 0-254 for
-- the sensor slot, because 255 is ELPRO's "unused" marker and a 255 arriving on
-- the wire means a mapping row was left half-filled, not that a sensor reported.
alter table meganet.reading drop constraint if exists reading_a2_station_range;
alter table meganet.reading add constraint reading_a2_station_range check (
  a2_station is null or (a2_station between 1 and 65535));

alter table meganet.reading drop constraint if exists reading_a2_sensor_range;
alter table meganet.reading add constraint reading_a2_sensor_range check (
  a2_sensor is null or (a2_sensor between 0 and 254));

-- The rollups carry the same denormalised copies of the address parts that they
-- already carry for alert_id and station_number, for the same reason: addr
-- determines them, and a rollup that outlives its readings still has to say what
-- it is a rollup of.
alter table meganet.reading_hourly
  add column if not exists a2_station integer,
  add column if not exists a2_sensor  integer;
alter table meganet.reading_daily
  add column if not exists a2_station integer,
  add column if not exists a2_sensor  integer;

-- ── Which station is ALERT2 station 1003? ────────────────────────────────────
-- A sibling of resolve_station() rather than a third argument on it, because
-- resolve_publisher() (0020) and resolve_readings() both call that one by its
-- current signature and a forward-only file does not get to change it underneath
-- them.
--
-- The unique index above means the count can only ever be 0 or 1, so the
-- count(*) = 1 form is belt and braces — but it is the same belt and braces
-- resolve_station() wears, and the contract it states is the point: unambiguous
-- or nothing. A null here is honest and is fixed later, by a person claiming the
-- address or by the station being added.
create or replace function meganet.resolve_a2_station(p_a2_station integer)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when pg_catalog.count(*) = 1 then pg_catalog.min(st.id) end
    from meganet.station st
   where p_a2_station is not null
     and st.deleted_at is null
     and st.alert2_station_id = p_a2_station;
$$;

comment on function meganet.resolve_a2_station(integer) is
  'Which station is this relayed ALERT2 station address? Null when nobody has claimed it — which is the normal state for traffic from a site MegaNet has not been told about yet.';

revoke all on function meganet.resolve_a2_station(integer) from public;
grant execute on function meganet.resolve_a2_station(integer) to anon, authenticated, service_role;

-- ── ingest() ─────────────────────────────────────────────────────────────────
-- Restated in full, the way 0004 → 0013 → 0015 restated save_station(), and for
-- the same reason: create or replace takes the whole body or none of it. Four
-- things change and everything else is 0006's text unaltered — the pair is
-- parsed, it is validated, it is resolved, and it is written.
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
        quality, protocol, source, path, raw_id)
      values (
        v_alert, v_a2_stn, v_a2_sen, v_sn, v_channel, v_station,
        v_ts, v_recv, v_raw, v_val, v_unit, v_conv,
        v_quality, v_protocol, v_source, v_path, v_raw_id)
      on conflict (addr, reading_ts, value_raw) do nothing;

      get diagnostics v_written = row_count;

      if v_written = 1 then
        n_ok := n_ok + 1;
      else
        -- Already heard. Count it, and remember the path it came by if it is one
        -- we have not seen for this reading — that is the repeater diagnostic.
        -- Capped at eight, because a reading heard by nine paths has already
        -- made its point and an unbounded array on a table this size has not.
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
  'The one way in. Takes a batch, validates each row, deduplicates against the primary key, resolves station_id where it can, and returns {accepted, duplicates, rejected:[{i,why}], raw_id}. One bad row never costs the batch.';

-- ── resolve_readings() ───────────────────────────────────────────────────────
-- The same coalesce, so the existing back-fill picks up relayed ALERT2 rows the
-- moment somebody claims the station they came from.
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
           coalesce(meganet.resolve_a2_station(r.a2_station),
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

comment on function meganet.resolve_readings(integer) is
  'Fill station_id on readings whose address has since become unambiguous, or whose ALERT2 station has since been claimed. Safe to run repeatedly.';

-- ── roll_up() ────────────────────────────────────────────────────────────────
-- Restated only to carry the two new columns into the rollups. A column that is
-- always null is worse than one that does not exist: the next person to read
-- reading_daily would take a null a2_station to mean "not an ALERT2 series"
-- rather than "nobody taught the rollup". Everything else is 0006's text.
create or replace function meganet.roll_up(p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_since   timestamptz;
  v_high    timestamptz;
  v_floor   timestamptz;
  v_hours   integer := 0;
  v_days    integer := 0;
  v_skipped integer := 0;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to roll up readings' using errcode = '42501';
  end if;

  v_since := coalesce(
    p_since,
    (select a.value::timestamptz from meganet.app_meta a where a.key = 'rollup_watermark'),
    '-infinity'::timestamptz);

  select pg_catalog.max(r.received_at) into v_high
    from meganet.reading r where r.received_at >= v_since;

  if v_high is null then
    return pg_catalog.jsonb_build_object('hours', 0, 'days', 0, 'skipped', 0,
                                         'since', v_since, 'watermark', v_since);
  end if;

  -- A bucket whose readings have already aged out cannot be recomputed — what is
  -- left of it would overwrite a rollup that was correct when it was made. So the
  -- sweep stops at the retention horizon and says how many buckets it left alone.
  v_floor := pg_catalog.date_trunc('hour',
               pg_catalog.now()
               - coalesce((select a.value::integer from meganet.app_meta a
                            where a.key = 'retain_reading_days'), 90)
                 * interval '1 day')
             + interval '1 hour';

  create temporary table pg_temp._roll_hours on commit drop as
    select distinct r.addr, pg_catalog.date_trunc('hour', r.reading_ts) as bucket
      from meganet.reading r
     where r.received_at >= v_since;

  select pg_catalog.count(*) into v_skipped from pg_temp._roll_hours where bucket < v_floor;
  delete from pg_temp._roll_hours where bucket < v_floor;

  insert into meganet.reading_hourly (
    addr, bucket, alert_id, a2_station, a2_sensor, station_number, channel,
    station_id, unit,
    n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
    val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
  select r.addr,
         pg_catalog.date_trunc('hour', r.reading_ts),
         -- addr determines these, so any row's copy is the value. max() rather
         -- than min() for station_id, so a backfilled row wins over a null.
         pg_catalog.max(r.alert_id),
         pg_catalog.max(r.a2_station),
         pg_catalog.max(r.a2_sensor),
         pg_catalog.max(r.station_number),
         pg_catalog.max(r.channel),
         pg_catalog.max(r.station_id),
         pg_catalog.max(r.unit),
         pg_catalog.count(*)::integer,
         coalesce(pg_catalog.sum(r.dup_count), 0)::integer,
         pg_catalog.count(r.value)::integer,
         pg_catalog.min(r.value_raw),
         pg_catalog.max(r.value_raw),
         pg_catalog.sum(r.value_raw),
         (pg_catalog.array_agg(r.value_raw order by r.reading_ts desc, r.received_at desc))[1],
         pg_catalog.min(r.value),
         pg_catalog.max(r.value),
         pg_catalog.sum(r.value),
         (pg_catalog.array_agg(r.value order by r.reading_ts desc, r.received_at desc)
            filter (where r.value is not null))[1],
         pg_catalog.min(r.reading_ts),
         pg_catalog.max(r.reading_ts),
         pg_catalog.now()
    from meganet.reading r
    join pg_temp._roll_hours h
      on h.addr = r.addr and h.bucket = pg_catalog.date_trunc('hour', r.reading_ts)
   group by r.addr, pg_catalog.date_trunc('hour', r.reading_ts)
  on conflict (addr, bucket) do update set
    alert_id = excluded.alert_id, station_number = excluded.station_number,
    a2_station = excluded.a2_station, a2_sensor  = excluded.a2_sensor,
    channel  = excluded.channel,  station_id     = excluded.station_id,
    unit     = excluded.unit,     n              = excluded.n,
    n_dup    = excluded.n_dup,    n_val          = excluded.n_val,
    raw_min  = excluded.raw_min,  raw_max        = excluded.raw_max,
    raw_sum  = excluded.raw_sum,  raw_last       = excluded.raw_last,
    val_min  = excluded.val_min,  val_max        = excluded.val_max,
    val_sum  = excluded.val_sum,  val_last       = excluded.val_last,
    first_ts = excluded.first_ts, last_ts        = excluded.last_ts,
    rolled_at = excluded.rolled_at;

  get diagnostics v_hours = row_count;

  -- The day is built from the hours, not from the readings. Sums re-aggregate
  -- exactly, which is why they are what is stored, and it means the daily rollup
  -- goes on being correct after the readings behind it are gone.
  insert into meganet.reading_daily (
    addr, bucket, alert_id, a2_station, a2_sensor, station_number, channel,
    station_id, unit,
    n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
    val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
  select h.addr,
         (h.bucket at time zone 'UTC')::date,
         pg_catalog.max(h.alert_id),
         pg_catalog.max(h.a2_station),
         pg_catalog.max(h.a2_sensor),
         pg_catalog.max(h.station_number),
         pg_catalog.max(h.channel),
         pg_catalog.max(h.station_id),
         pg_catalog.max(h.unit),
         pg_catalog.sum(h.n)::integer,
         pg_catalog.sum(h.n_dup)::integer,
         pg_catalog.sum(h.n_val)::integer,
         pg_catalog.min(h.raw_min),
         pg_catalog.max(h.raw_max),
         pg_catalog.sum(h.raw_sum),
         (pg_catalog.array_agg(h.raw_last order by h.bucket desc))[1],
         pg_catalog.min(h.val_min),
         pg_catalog.max(h.val_max),
         pg_catalog.sum(h.val_sum),
         (pg_catalog.array_agg(h.val_last order by h.bucket desc)
            filter (where h.val_last is not null))[1],
         pg_catalog.min(h.first_ts),
         pg_catalog.max(h.last_ts),
         pg_catalog.now()
    from meganet.reading_hourly h
   where exists (select 1 from pg_temp._roll_hours t
                  where t.addr = h.addr
                    and (t.bucket at time zone 'UTC')::date = (h.bucket at time zone 'UTC')::date)
   group by h.addr, (h.bucket at time zone 'UTC')::date
  on conflict (addr, bucket) do update set
    alert_id = excluded.alert_id, station_number = excluded.station_number,
    a2_station = excluded.a2_station, a2_sensor  = excluded.a2_sensor,
    channel  = excluded.channel,  station_id     = excluded.station_id,
    unit     = excluded.unit,     n              = excluded.n,
    n_dup    = excluded.n_dup,    n_val          = excluded.n_val,
    raw_min  = excluded.raw_min,  raw_max        = excluded.raw_max,
    raw_sum  = excluded.raw_sum,  raw_last       = excluded.raw_last,
    val_min  = excluded.val_min,  val_max        = excluded.val_max,
    val_sum  = excluded.val_sum,  val_last       = excluded.val_last,
    first_ts = excluded.first_ts, last_ts        = excluded.last_ts,
    rolled_at = excluded.rolled_at;

  get diagnostics v_days = row_count;

  drop table pg_temp._roll_hours;

  insert into meganet.app_meta (key, value)
  values ('rollup_watermark', v_high::text)
  on conflict (key) do update set value = excluded.value;

  return pg_catalog.jsonb_build_object(
    'hours', v_hours, 'days', v_days, 'skipped', v_skipped,
    'since', v_since, 'watermark', v_high);
end;
$$;

comment on function meganet.roll_up(timestamptz) is
  'Rebuild the hourly and daily rollups for every bucket touched since the watermark. Idempotent; running it twice changes nothing.';

-- ── The rows that were filed under the wrong address ─────────────────────────
-- 960 of them at the time of writing, from four relayed stations. `addr` is
-- generated and it is the primary key, so re-filing is a delete and an insert
-- rather than an update.
--
-- The filter is the topic, not the protocol code. One live row is protocol 5 and
-- carries `alert_id` 9003 with no `Station N` tail: it arrived by the other ELPRO
-- payload shape, where the JSON key is the Payload Prefix the technician typed
-- and *is* a real ALERT address. That row is correct and must not be touched, and
-- keying on the tail is what leaves it alone without having to name it.
--
-- Sensor slots above 254 are excluded rather than clamped or guessed at. None
-- exist today; if one ever arrives it stays where it is and the assertion at the
-- foot of this file reports it, which is the same bargain 0006 makes with an
-- address it cannot resolve.
--
-- Naturally idempotent: a second run finds nothing, because the rows it would
-- have moved no longer carry an alert_id.

with doomed as (
  select r.addr, r.reading_ts, r.value_raw, r.alert_id, r.station_id,
         r.received_at, r.value, r.unit, r.conversion, r.quality, r.protocol,
         r.source, r.path, r.dup_count, r.dup_paths, r.last_dup_at, r.raw_id,
         r.ingest_token_id,
         (pg_catalog.substring(r.path, 'Station ([0-9]+)$'))::integer as a2_station
    from meganet.reading r
   where r.protocol = 5
     and r.alert_id is not null
     and r.alert_id between 0 and 254
     and r.path ~ 'Station [0-9]+$'
),
removed as (
  delete from meganet.reading r
   using doomed d
   where r.addr = d.addr
     and r.reading_ts = d.reading_ts
     and r.value_raw = d.value_raw
  returning r.addr
)
insert into meganet.reading (
  a2_station, a2_sensor, channel, station_id, reading_ts, received_at,
  value_raw, value, unit, conversion, quality, protocol, source, path,
  dup_count, dup_paths, last_dup_at, raw_id, ingest_token_id)
select d.a2_station, d.alert_id, '',
       meganet.resolve_a2_station(d.a2_station),
       d.reading_ts, d.received_at, d.value_raw, d.value, d.unit, d.conversion,
       d.quality, d.protocol, d.source, d.path, d.dup_count, d.dup_paths,
       d.last_dup_at, d.raw_id, d.ingest_token_id
  from doomed d
on conflict (addr, reading_ts, value_raw) do nothing;

-- ── What has been heard, whether or not anybody has named it ─────────────────
-- The other half of "claim the station, then name its sensors". Inventing a
-- meganet.sensor row per slot was the alternative and it was refused: `type` is
-- not null, so a placeholder row would have to state what the instrument
-- measures, which is exactly the thing nobody knows yet. This states what is
-- true instead — that slot 9 on station 1000 has sent 260 readings and the last
-- one was 248 — and leaves the registry to people who can vouch for it.
--
-- security_invoker, like every other view in this schema bar 0023's seven: it
-- reads meganet.reading, whose select policy is already the right answer.
create or replace view meganet.a2_sensor_seen
with (security_invoker = true) as
select r.a2_station,
       r.a2_sensor,
       pg_catalog.count(*)::integer                                as n,
       pg_catalog.min(r.reading_ts)                                as first_ts,
       pg_catalog.max(r.reading_ts)                                as last_ts,
       (pg_catalog.array_agg(r.value_raw order by r.reading_ts desc))[1] as last_value,
       pg_catalog.max(r.station_id)                                as station_id,
       (select s.sensor_id from meganet.sensor s
         where s.station_id = pg_catalog.max(r.station_id)
           and s.alert2_sensor_id = r.a2_sensor
         limit 1)                                                  as named_as
  from meganet.reading r
 where r.a2_station is not null
 group by r.a2_station, r.a2_sensor;

comment on view meganet.a2_sensor_seen is
  'Every relayed ALERT2 station and sensor slot that has actually sent something, with how much and how recently. named_as is null for a slot no meganet.sensor row claims yet.';

grant select on meganet.a2_sensor_seen to anon, authenticated, service_role;

-- ── Claiming an address from the other end ───────────────────────────────────
-- Until now the only way to attribute traffic was forward: find the station,
-- type its identifiers in, wait for the next reading. These two are the reverse,
-- and they exist as their own functions rather than as a call to save_station()
-- for two reasons. save_station() rebuilds the repeater object wholesale from
-- whatever the form sent, so a caller that holds a message rather than a station
-- would erase things it never saw; and it takes an optimistic-lock stamp the
-- Message Log has no reason to be holding.
--
-- Both do the whole job in one transaction — write the mapping, then back-fill
-- every reading that shares the identity — because a mapping that is saved but
-- not applied looks exactly like one that did not work.

create or replace function meganet.claim_a2_station(
  p_a2_station integer,
  p_station_id text,
  p_replace    boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incumbent   text;
  v_name        text;
  v_claimed     integer := 0;
  v_slots       integer := 0;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to claim an address' using errcode = '42501';
  end if;

  if p_a2_station is null or p_a2_station < 1 or p_a2_station > 65535 then
    raise exception 'a2_station % is outside 1-65535', p_a2_station using errcode = '23514';
  end if;

  select st.name into v_name
    from meganet.station st
   where st.id = p_station_id and st.deleted_at is null;
  if v_name is null then
    raise exception 'no station % to claim it for', p_station_id using errcode = '23503';
  end if;

  -- Somebody else's already. Refuse by name rather than by error code, because
  -- the person reading this is looking at a message and has no other way to find
  -- out who holds it.
  select st.id into v_incumbent
    from meganet.station st
   where st.alert2_station_id = p_a2_station
     and st.deleted_at is null
     and st.id <> p_station_id;

  if v_incumbent is not null then
    if not p_replace then
      raise exception 'ALERT2 station % already belongs to % — pass p_replace to move it',
        p_a2_station, v_incumbent
        using errcode = '23505';
    end if;
    update meganet.station
       set alert2_station_id = null, updated_at = pg_catalog.now(),
           updated_by = meganet.actor()
     where id = v_incumbent;
  end if;

  update meganet.station
     set alert2_station_id = p_a2_station,
         updated_at = pg_catalog.now(),
         updated_by = meganet.actor()
   where id = p_station_id
     and alert2_station_id is distinct from p_a2_station;

  -- The point of the exercise. `is distinct from` rather than `is null` so that
  -- a move under p_replace takes the readings with it — the address is what
  -- says whose they are, and it has just changed its mind.
  update meganet.reading r
     set station_id = p_station_id
   where r.a2_station = p_a2_station
     and r.station_id is distinct from p_station_id;
  get diagnostics v_claimed = row_count;

  select pg_catalog.count(*)::integer into v_slots
    from meganet.a2_sensor_seen v where v.a2_station = p_a2_station;

  return pg_catalog.jsonb_build_object(
    'station_id',  p_station_id,
    'name',        v_name,
    'a2_station',  p_a2_station,
    'claimed',     v_claimed,
    'sensors_seen', v_slots,
    'replaced',    v_incumbent);
end;
$$;

comment on function meganet.claim_a2_station(integer, text, boolean) is
  'Attribute a relayed ALERT2 station to a MegaNet station and back-fill every reading it has ever sent. Returns how many were claimed and how many sensor slots are waiting to be named.';

revoke all on function meganet.claim_a2_station(integer, text, boolean) from public;
grant execute on function meganet.claim_a2_station(integer, text, boolean) to authenticated, service_role;

create or replace function meganet.claim_alert_address(
  p_alert_id  integer,
  p_station_id text,
  p_type      text,
  p_sensor_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name    text;
  v_other   text;
  v_sid     text;
  v_ord     integer;
  v_claimed integer := 0;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to claim an address' using errcode = '42501';
  end if;

  if p_alert_id is null or p_alert_id < 1 or p_alert_id > 65535 then
    raise exception 'alert_id % is outside 1-65535', p_alert_id using errcode = '23514';
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_type, '')), '') is null then
    raise exception 'a sensor needs a type — what does this address measure?'
      using errcode = '23502';
  end if;

  select st.name into v_name
    from meganet.station st
   where st.id = p_station_id and st.deleted_at is null;
  if v_name is null then
    raise exception 'no station % to claim it for', p_station_id using errcode = '23503';
  end if;

  -- An ALERT address on two stations resolves to neither — that is
  -- resolve_station()'s whole contract, and 604 addresses are already in that
  -- state. Claiming into it would not attribute this traffic, it would
  -- un-attribute somebody else's, so it is refused rather than warned about.
  -- Moving an address off the station that holds it is the station editor's job.
  select s.station_id into v_other
    from meganet.sensor s
    join meganet.station st on st.id = s.station_id and st.deleted_at is null
   where s.alert_id = p_alert_id and s.station_id <> p_station_id
   limit 1;
  if v_other is not null then
    raise exception 'ALERT address % is already on % — two stations sharing it would resolve to neither',
      p_alert_id, v_other
      using errcode = '23505';
  end if;

  v_sid := coalesce(nullif(pg_catalog.btrim(coalesce(p_sensor_id, '')), ''),
                    p_station_id || ':' || p_alert_id);

  select coalesce(pg_catalog.max(s.ord), -1) + 1 into v_ord
    from meganet.sensor s where s.station_id = p_station_id;

  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, updated_by)
  values (p_station_id, v_sid, pg_catalog.btrim(p_type), v_ord, p_alert_id, meganet.actor())
  on conflict (station_id, sensor_id, type) do update
     set alert_id = excluded.alert_id, updated_by = excluded.updated_by;

  update meganet.reading r
     set station_id = p_station_id
   where r.alert_id = p_alert_id
     and r.station_id is distinct from p_station_id;
  get diagnostics v_claimed = row_count;

  return pg_catalog.jsonb_build_object(
    'station_id', p_station_id,
    'name',       v_name,
    'alert_id',   p_alert_id,
    'sensor_id',  v_sid,
    'claimed',    v_claimed);
end;
$$;

comment on function meganet.claim_alert_address(integer, text, text, text) is
  'Attach an ALERT address to a station as a sensor and back-fill every reading it has ever sent. Refuses an address another station already holds, because two claims on one address resolve to neither.';

revoke all on function meganet.claim_alert_address(integer, text, text, text) from public;
grant execute on function meganet.claim_alert_address(integer, text, text, text) to authenticated, service_role;

-- ── The document ─────────────────────────────────────────────────────────────
-- Restated from 0015 to carry the two new fields. Both are added by conditional
-- merge rather than as plain keys, so a station with no ALERT2 address and a
-- sensor with no slot produce byte-identical fragments to the ones 0015 made —
-- 3,174 stations and 8,818 sensors that have nothing to do with this file do not
-- get a null key each, and tools/snapshot_stations_json.py does not report the
-- whole document as changed.
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
       as doc
  from meganet.station s
  left join sensor_doc sd on sd.station_id = s.id
  left join meganet.repeater r on r.station_id = s.id
  left join range_doc rd on rd.repeater_id = s.id
 where s.deleted_at is null;

comment on view meganet.station_json is
  'One row per live station: its id, its position in the document, its updated_at, and its stations.json fragment.';

-- ── Saving ───────────────────────────────────────────────────────────────────
-- Restated from 0015. Three changes, and the third is the one that would have
-- been easy to miss: the station carries alert2_station_id, each sensor carries
-- alert2_sensor_id, and the key minted for a sensor the operator typed by hand
-- now prefers the ALERT2 slot over the row's position. Without that last part an
-- ALERT2-only sensor — no ARRO sensor_id, no ALERT address — would key off
-- `(ord - 1)`, and reordering the rows in the form would delete and re-insert
-- every one of them under new names.
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
    if v_delay is not null and (v_delay < 0 or v_delay > 999) then
      raise exception 'repeater delay must be between 0 and 999 ms, not %', v_delay
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
  if v_a2 is not null and exists (
       select 1 from meganet.station st
        where st.alert2_station_id = v_a2 and st.deleted_at is null and st.id <> v_id) then
    raise exception 'ALERT2 station address % already belongs to another station', v_a2
      using errcode = '22023',
            hint    = 'two stations on one address would resolve to neither — clear it there first';
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

  -- Lock the row before reading its stamp, so the check below and the write
  -- after it see the same version. Without the lock two saves can both read the
  -- stamp they expect and both proceed.
  select updated_at, deleted_at into v_prev, v_deleted
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

  -- Position in the document. An existing station keeps its place; a new one
  -- goes on the end, which is where an appended station lands in the file too.
  if v_is_new then
    select coalesce(max(ord), -1) + 1 into v_ord from meganet.station;
  else
    select ord into v_ord from meganet.station where id = v_id;
  end if;

  insert into meganet.station (
    id, ord, name, station_number, lat, lon, elevation_ahd,
    roles, radio_network_ids, catchment_ids, alert_ids, satcom,
    rm_system_id, enabled, notes, legacy_unit_id, site, lga, basin,
    location_types, tbrg_bucket_size, inspection_config_key,
    alert2_station_id, deleted_at, updated_by)
  values (
    v_id, v_ord,
    p_doc ->> 'name',
    coalesce(p_doc ->> 'station_number', ''),
    (p_doc ->> 'lat')::numeric,
    (p_doc ->> 'lon')::numeric,
    (p_doc ->> 'elevation_ahd')::numeric,
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
    -- Saving a station that had been deleted brings it back. The alternative is
    -- refusing the save of a station the editor is looking at, which would be a
    -- puzzle rather than a safeguard.
    null,
    v_actor)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon,
         elevation_ahd = excluded.elevation_ahd, roles = excluded.roles,
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

comment on function meganet.save_station(jsonb, timestamptz) is
  'Insert or update one station and everything hanging off it, in one transaction. Refuses a stale write with SQLSTATE PT409 (HTTP 409). Returns the saved document fragment and its new updated_at.';

-- ── Loading ──────────────────────────────────────────────────────────────────
-- Restated from 0022 for one clause. The loader is a sync, and 0022 taught it
-- not to prune rows belonging to a station the document does not own. There is a
-- second kind of row it does not own, one level down: a sensor whose identity is
-- an ALERT2 slot.
--
-- The sequence that would have lost it is short enough to be worth spelling out.
-- Somebody claims ALERT2 station 1003 onto a real site and names slot 13 in the
-- station editor. That sensor row is not in stations.json — it cannot be, the
-- snapshot in this repo predates the column. The next stations load prunes it,
-- resolve_a2_station() goes on working because the address is on the station,
-- but the slot loses its name and its type, silently, exactly the way `elpro_test`
-- lost its sensors before 0022.
--
-- The exemption is `alert2_sensor_id is not null` rather than "a row the loader
-- did not write". The second was the first thing tried and it is too wide: sensor
-- rows carry updated_by, so any sensor a person had ever edited would stop being
-- prunable, and a sensor deleted from the document would then survive. This one
-- covers only what the document currently has no way to express. Once
-- tools/snapshot_stations_json.py round-trips the field it becomes belt and
-- braces rather than the thing holding it up.
create or replace function meganet.load_stations_doc(doc jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_station    integer;
  n_sensor     integer;
  n_repeater   integer;
  n_range      integer;
  n_inverted   integer;
  bad_ref      text;
begin
  if doc is null or jsonb_typeof(doc -> 'stations') is distinct from 'array' then
    raise exception 'not a stations document: stations[] is missing or is not an array';
  end if;

  -- Refuse a document that does not hang together, before touching anything.
  -- rm_system_id is a real foreign key so Postgres would catch it anyway, but
  -- radio_network_ids and catchment_ids are arrays and Postgres has no
  -- per-element referential integrity. A bad id in one of those would load
  -- silently and surface later as a filter option matching nothing.
  select string_agg(msg, '; ') into bad_ref from (
    select format('%s: unknown radio_network_id %L', s.value ->> 'id', v) as msg
      from jsonb_array_elements(doc -> 'stations') s
      cross join lateral jsonb_array_elements_text(
             coalesce(s.value -> 'radio_network_ids', '[]'::jsonb)) v
     where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'radio_networks', '[]'::jsonb)) n
                        where n.value ->> 'id' = v)
    union all
    select format('%s: unknown catchment_id %L', s.value ->> 'id', v)
      from jsonb_array_elements(doc -> 'stations') s
      cross join lateral jsonb_array_elements_text(
             coalesce(s.value -> 'catchment_ids', '[]'::jsonb)) v
     where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) c
                        where c.value ->> 'id' = v)
    limit 20
  ) problems;

  if bad_ref is not null then
    raise exception 'document does not hang together — %', bad_ref;
  end if;

  -- ── meta ──────────────────────────────────────────────────────────────────
  insert into meganet.doc_meta (only_row, version, description, updated, rm_paths, updated_by)
  select true,
         coalesce(doc -> 'meta' ->> 'version', ''),
         coalesce(doc -> 'meta' ->> 'description', ''),
         (doc -> 'meta' ->> 'updated')::date,
         coalesce(doc -> 'meta' -> 'rm_paths', '{}'::jsonb),
         'load_stations_doc'
  on conflict (only_row) do update
     set version = excluded.version, description = excluded.description,
         updated = excluded.updated, rm_paths = excluded.rm_paths,
         updated_by = excluded.updated_by
   where (meganet.doc_meta.version, meganet.doc_meta.description,
          meganet.doc_meta.updated, meganet.doc_meta.rm_paths)
      is distinct from (excluded.version, excluded.description,
          excluded.updated, excluded.rm_paths);

  -- ── reference lists ───────────────────────────────────────────────────────
  insert into meganet.rm_system (id, ord, name, tx_power_w, line_loss_db, supp_loss_db_m,
                                 antenna_type, antenna_gain_dbi, antenna_height_m,
                                 rx_threshold_dbm, updated_by)
  select (e.value ->> 'id')::integer, (e.ord - 1)::integer,
         coalesce(e.value ->> 'name', ''),
         (e.value ->> 'tx_power_w')::numeric, (e.value ->> 'line_loss_db')::numeric,
         (e.value ->> 'supp_loss_db_m')::numeric, e.value ->> 'antenna_type',
         (e.value ->> 'antenna_gain_dbi')::numeric, (e.value ->> 'antenna_height_m')::numeric,
         (e.value ->> 'rx_threshold_dbm')::numeric, 'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'rm_systems', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, tx_power_w = excluded.tx_power_w,
         line_loss_db = excluded.line_loss_db, supp_loss_db_m = excluded.supp_loss_db_m,
         antenna_type = excluded.antenna_type, antenna_gain_dbi = excluded.antenna_gain_dbi,
         antenna_height_m = excluded.antenna_height_m,
         rx_threshold_dbm = excluded.rx_threshold_dbm, updated_by = excluded.updated_by
   where (meganet.rm_system.ord, meganet.rm_system.name, meganet.rm_system.tx_power_w,
          meganet.rm_system.line_loss_db, meganet.rm_system.supp_loss_db_m,
          meganet.rm_system.antenna_type, meganet.rm_system.antenna_gain_dbi,
          meganet.rm_system.antenna_height_m, meganet.rm_system.rx_threshold_dbm)
      is distinct from (excluded.ord, excluded.name, excluded.tx_power_w,
          excluded.line_loss_db, excluded.supp_loss_db_m, excluded.antenna_type,
          excluded.antenna_gain_dbi, excluded.antenna_height_m, excluded.rx_threshold_dbm);

  insert into meganet.radio_network (id, ord, name, description, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer,
         coalesce(e.value ->> 'name', ''), coalesce(e.value ->> 'description', ''),
         'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'radio_networks', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         description = excluded.description, updated_by = excluded.updated_by
   where (meganet.radio_network.ord, meganet.radio_network.name, meganet.radio_network.description)
      is distinct from (excluded.ord, excluded.name, excluded.description);

  insert into meganet.catchment (id, ord, name, basin_no, area_sqkm, region, border, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         e.value ->> 'basin_no', (e.value ->> 'area_sqkm')::numeric,
         e.value ->> 'region', e.value ->> 'border', 'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, basin_no = excluded.basin_no,
         area_sqkm = excluded.area_sqkm, region = excluded.region,
         border = excluded.border, updated_by = excluded.updated_by
   where (meganet.catchment.ord, meganet.catchment.name, meganet.catchment.basin_no,
          meganet.catchment.area_sqkm, meganet.catchment.region, meganet.catchment.border)
      is distinct from (excluded.ord, excluded.name, excluded.basin_no,
          excluded.area_sqkm, excluded.region, excluded.border);

  -- ── stations ──────────────────────────────────────────────────────────────
  insert into meganet.station (id, ord, name, station_number, lat, lon, elevation_ahd,
                               roles, radio_network_ids, catchment_ids, alert_ids, satcom,
                               rm_system_id, enabled, notes, legacy_unit_id, site, lga,
                               basin, location_types, tbrg_bucket_size,
                               inspection_config_key, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         coalesce(e.value ->> 'station_number', ''),
         (e.value ->> 'lat')::numeric, (e.value ->> 'lon')::numeric,
         (e.value ->> 'elevation_ahd')::numeric,
         coalesce((select array_agg(v order by o)
                     from jsonb_array_elements_text(e.value -> 'roles') with ordinality t(v, o)),
                  '{}'::text[]),
         coalesce((select array_agg(v order by o)
                     from jsonb_array_elements_text(e.value -> 'radio_network_ids') with ordinality t(v, o)),
                  '{}'::text[]),
         coalesce((select array_agg(v order by o)
                     from jsonb_array_elements_text(e.value -> 'catchment_ids') with ordinality t(v, o)),
                  '{}'::text[]),
         coalesce(e.value -> 'alert_ids', '{}'::jsonb),
         coalesce(e.value -> 'satcom', '{}'::jsonb),
         (e.value ->> 'rm_system_id')::integer,
         coalesce((e.value ->> 'enabled')::boolean, true),
         coalesce(e.value ->> 'notes', ''),
         (e.value ->> 'legacy_unit_id')::integer,
         e.value -> 'site',
         e.value ->> 'lga',
         e.value ->> 'basin',
         (select array_agg(v order by o)
            from jsonb_array_elements_text(e.value -> 'location_types') with ordinality t(v, o)),
         (e.value ->> 'TBRGbucketSize')::numeric,
         nullif(e.value ->> 'inspection_config_key', ''),
         'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon, elevation_ahd = excluded.elevation_ahd,
         roles = excluded.roles, radio_network_ids = excluded.radio_network_ids,
         catchment_ids = excluded.catchment_ids, alert_ids = excluded.alert_ids,
         satcom = excluded.satcom, rm_system_id = excluded.rm_system_id,
         enabled = excluded.enabled, notes = excluded.notes,
         legacy_unit_id = excluded.legacy_unit_id, site = excluded.site,
         lga = excluded.lga, basin = excluded.basin,
         location_types = excluded.location_types,
         tbrg_bucket_size = excluded.tbrg_bucket_size,
         inspection_config_key = excluded.inspection_config_key,
         updated_by = excluded.updated_by
   where (meganet.station.ord, meganet.station.name, meganet.station.station_number,
          meganet.station.lat, meganet.station.lon, meganet.station.elevation_ahd,
          meganet.station.roles, meganet.station.radio_network_ids,
          meganet.station.catchment_ids, meganet.station.alert_ids, meganet.station.satcom,
          meganet.station.rm_system_id, meganet.station.enabled, meganet.station.notes,
          meganet.station.legacy_unit_id, meganet.station.site, meganet.station.lga,
          meganet.station.basin, meganet.station.location_types,
          meganet.station.tbrg_bucket_size, meganet.station.inspection_config_key)
      is distinct from (excluded.ord, excluded.name, excluded.station_number, excluded.lat,
          excluded.lon, excluded.elevation_ahd, excluded.roles, excluded.radio_network_ids,
          excluded.catchment_ids, excluded.alert_ids, excluded.satcom, excluded.rm_system_id,
          excluded.enabled, excluded.notes, excluded.legacy_unit_id, excluded.site,
          excluded.lga, excluded.basin, excluded.location_types,
          excluded.tbrg_bucket_size, excluded.inspection_config_key);

  -- Stations the document no longer carries. Cascades to their sensors,
  -- repeater row and pass ranges, so this is also the tidy-up for those.
  --
  -- `document_managed` is the whole of 0022's change to this function. Every
  -- station that came out of stations.json has it true and is pruned exactly as
  -- before; a row this schema created for itself has it false and is left alone,
  -- because a document cannot be evidence that a row it never owned should go.
  delete from meganet.station t
   where t.document_managed
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') e
                      where e.value ->> 'id' = t.id);

  -- ── sensors ───────────────────────────────────────────────────────────────
  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, device_id, updated_by)
  select s.value ->> 'id', x.value ->> 'sensor_id', x.value ->> 'type', (x.ord - 1)::integer,
         (x.value ->> 'alert_id')::integer, (x.value ->> 'device_id')::integer,
         'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'sensors', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, sensor_id, type) do update
     set ord = excluded.ord, alert_id = excluded.alert_id,
         device_id = excluded.device_id, updated_by = excluded.updated_by
   where (meganet.sensor.ord, meganet.sensor.alert_id, meganet.sensor.device_id)
      is distinct from (excluded.ord, excluded.alert_id, excluded.device_id);

  -- Same rule, one level down: a sensor belongs to a station, so it is the
  -- station's provenance that decides whether the document may remove it.
  -- elpro_test's three addresses are what resolve_station() matches an incoming
  -- alert_id against, so pruning them is pruning the test rig's identity.
  delete from meganet.sensor t
   where t.alert2_sensor_id is null
     and exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (
     select 1 from jsonb_array_elements(doc -> 'stations') s
       cross join lateral jsonb_array_elements(coalesce(s.value -> 'sensors', '[]'::jsonb)) x
      where s.value ->> 'id' = t.station_id
        and x.value ->> 'sensor_id' = t.sensor_id
        and x.value ->> 'type' = t.type);

  -- ── repeaters ─────────────────────────────────────────────────────────────
  insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, delay_ms, notes, updated_by)
  select s.value ->> 'id', coalesce(s.value -> 'repeater' ->> 'acma_licence', ''),
         (s.value -> 'repeater' ->> 'rx_mhz')::numeric,
         (s.value -> 'repeater' ->> 'tx_mhz')::numeric,
         (s.value -> 'repeater' ->> 'delay_ms')::integer,
         coalesce(s.value -> 'repeater' ->> 'notes', ''), 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
   where s.value ? 'repeater'
  on conflict (station_id) do update
     set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
         tx_mhz = excluded.tx_mhz, delay_ms = excluded.delay_ms,
         notes = excluded.notes, updated_by = excluded.updated_by
   where (meganet.repeater.acma_licence, meganet.repeater.rx_mhz,
          meganet.repeater.tx_mhz, meganet.repeater.delay_ms, meganet.repeater.notes)
      is distinct from (excluded.acma_licence, excluded.rx_mhz,
          excluded.tx_mhz, excluded.delay_ms, excluded.notes);

  delete from meganet.repeater t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id and s.value ? 'repeater');

  -- ── pass ranges ───────────────────────────────────────────────────────────
  insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by)
  select r.station_id, r.kind, r.lo, r.hi, r.ord, 'load_stations_doc'
    from (
      select s.value ->> 'id' as station_id, k.kind,
             (p.value ->> 'low')::integer as lo, (p.value ->> 'high')::integer as hi,
             (p.ord - 1)::integer as ord
        from jsonb_array_elements(doc -> 'stations') s
        cross join lateral (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions'))
                   as k(kind, field)
        cross join lateral jsonb_array_elements(
                     coalesce(s.value -> 'repeater' -> k.field, '[]'::jsonb))
                   with ordinality p(value, ord)
    ) r
  on conflict (repeater_id, kind, lo, hi) do update
     set ord = excluded.ord, updated_by = excluded.updated_by
   where meganet.pass_range.ord is distinct from excluded.ord;

  delete from meganet.pass_range t
   where exists (select 1 from meganet.station st
                  where st.id = t.repeater_id and st.document_managed)
     and not exists (
     select 1 from jsonb_array_elements(doc -> 'stations') s
       cross join lateral (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions'))
                  as k(kind, field)
       cross join lateral jsonb_array_elements(
                    coalesce(s.value -> 'repeater' -> k.field, '[]'::jsonb)) p
      where s.value ->> 'id' = t.repeater_id
        and k.kind = t.kind
        and (p.value ->> 'low')::integer = t.lo
        and (p.value ->> 'high')::integer = t.hi);

  -- Reference rows the document dropped. Last, because a station still pointing
  -- at an rm_system is a foreign key that would (correctly) refuse the delete.
  delete from meganet.rm_system t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'rm_systems', '[]'::jsonb)) e
                      where (e.value ->> 'id')::integer = t.id);
  delete from meganet.radio_network t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'radio_networks', '[]'::jsonb)) e
                      where e.value ->> 'id' = t.id);
  delete from meganet.catchment t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) e
                      where e.value ->> 'id' = t.id);

  select count(*) into n_station  from meganet.station;
  select count(*) into n_sensor   from meganet.sensor;
  select count(*) into n_repeater from meganet.repeater;
  select count(*) into n_range    from meganet.pass_range;
  select count(*) into n_inverted from meganet.pass_range where hi < lo;

  -- Said out loud on every run rather than left to be discovered: a range whose
  -- low is above its high passes no address at all, here or in the app.
  if n_inverted > 0 then
    raise notice 'note: % pass range(s) are inverted and match no address', n_inverted;
  end if;

  return format('loaded %s stations, %s sensors, %s repeaters, %s pass ranges%s',
                n_station, n_sensor, n_repeater, n_range,
                case when n_inverted > 0
                     then format(' (%s inverted range(s) — see db/README.md)', n_inverted)
                     else '' end);
end
$$;

comment on function meganet.load_stations_doc(jsonb) is
  'Load stations.json into the registry. A sync: the document is authoritative for every station it owns. It does not prune stations, sensors, repeaters or pass ranges belonging to a station outside the document (0022), nor a sensor whose identity is an ALERT2 slot the document cannot yet carry (0024).';

-- ── Did it take? ─────────────────────────────────────────────────────────────
-- 0022's habit, for 0022's reason: this file rebuilds a primary key and re-files
-- rows under new identities, and both of those fail in ways that read as working.
-- Every check below holds vacuously on the empty database CI applies this to, and
-- says something on a database with the bench feed in it.

do $$
declare
  v_expr    text;
  v_stranded integer;
  v_moved    integer;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'meganet' and table_name = 'reading'
       and column_name in ('a2_station', 'a2_sensor')
     having pg_catalog.count(*) = 2) then
    raise exception '0024 did not take: meganet.reading is missing a2_station / a2_sensor';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'meganet' and table_name = 'station'
       and column_name = 'alert2_station_id') then
    raise exception '0024 did not take: meganet.station.alert2_station_id is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'meganet' and table_name = 'sensor'
       and column_name = 'alert2_sensor_id') then
    raise exception '0024 did not take: meganet.sensor.alert2_sensor_id is missing';
  end if;

  -- The surgery is the part that can half-happen: a dropped generated column
  -- that comes back as a plain one would take every future insert without a
  -- word and store nulls where the primary key used to be.
  select pg_catalog.pg_get_expr(d.adbin, d.adrelid) into v_expr
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'meganet.reading'::regclass
     and a.attname = 'addr'
     and a.attgenerated = 's';
  if v_expr is null then
    raise exception '0024 did not take: meganet.reading.addr is not a stored generated column any more';
  end if;
  if pg_catalog.strpos(v_expr, 'a2:') = 0 then
    raise exception '0024 did not take: meganet.reading.addr still has no ALERT2 shape — %', v_expr;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'meganet.reading'::regclass and conname = 'reading_pkey') then
    raise exception '0024 did not take: meganet.reading has no primary key';
  end if;

  -- Every relayed row that could be re-filed, was. A row still carrying an ALERT
  -- address under a `Station N` topic is one the rewrite missed.
  select pg_catalog.count(*) into v_stranded
    from meganet.reading r
   where r.protocol = 5
     and r.alert_id is not null
     and r.alert_id between 0 and 254
     and r.path ~ 'Station [0-9]+$';
  if v_stranded > 0 then
    raise exception '0024 did not take: % relayed ALERT2 readings are still filed under an ALERT address', v_stranded;
  end if;

  -- And the ones deliberately left alone are reported rather than hidden: a
  -- sensor slot above 254 has nowhere valid to go, and the file would rather say
  -- so than clamp it. Zero today.
  select pg_catalog.count(*) into v_stranded
    from meganet.reading r
   where r.protocol = 5
     and r.alert_id is not null
     and r.alert_id > 254
     and r.path ~ 'Station [0-9]+$';
  if v_stranded > 0 then
    raise warning '0024: % relayed readings carry a sensor slot above 254 and were left where they are', v_stranded;
  end if;

  -- The collision this file exists to close. Two relayed stations sharing a
  -- sensor slot must now be two addresses, not one.
  select pg_catalog.count(*) into v_moved
    from (select r.a2_sensor from meganet.reading r
           where r.a2_station is not null
           group by r.a2_sensor
          having pg_catalog.count(distinct r.a2_station) > 1) collided;
  if v_moved > 0 and exists (
       select 1 from meganet.reading r
        where r.a2_station is not null
        group by r.addr
       having pg_catalog.count(distinct r.a2_station) > 1) then
    raise exception '0024 did not take: one addr still covers more than one ALERT2 station';
  end if;
end
$$;

notify pgrst, 'reload schema';

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 23 → 24 in the same commit as this file.
-- 0013's note records why that is said here rather than remembered: 0012 bumped
-- the database and missed the app, and the app showed a schema-mismatch banner
-- until #147 found it.

insert into meganet.app_meta (key, value)
values ('schema_version', '24')
on conflict (key) do update set value = excluded.value;
