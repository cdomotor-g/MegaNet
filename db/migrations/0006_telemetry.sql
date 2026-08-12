-- 0006_telemetry.sql — One reading table, one way in, and a retention policy
-- that exists before the first row does.
--
-- Everything that will ever write a field-station reading — HTTP POST (#B5), the
-- MQTT bridge (#B6), a backfill from ARRO, a person typing one in — goes through
-- meganet.ingest(). Build the adapters first and you get two payload formats that
-- disagree about timestamps; this file is what makes each adapter thin.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0006_telemetry.sql
--
-- Six decisions run through everything below. They are stated here rather than
-- discovered in the SQL, because each one is a domain fact that is expensive to
-- retrofit.
--
-- **1. The address is the identity, not the station.** A packet carries an
-- address. Which station that is may be unknown — 604 of 5,122 ALERT addresses in
-- the current data belong to more than one station, and a brand-new site reports
-- before anyone adds it to MegaNet. `station_id` is nullable and backfillable;
-- the address is not. *A reading is never dropped because its address is
-- unresolved.* The ALERT2 tab has lived with exactly this since it shipped
-- (`hideUnknown`, app.js ~450).
--
-- **2. There is more than one kind of address, and there will be more than two
-- kinds of protocol.** A radio station is addressed by its ALERT address. A
-- satellite or cellular station is not radio at all and has no ALERT address —
-- it reports under its *station number*, and needs a channel to say which of its
-- sensors is speaking, because the number names the site rather than the
-- measurement. So `alert_id` is nullable too, and the dedupe identity is the
-- generated `addr` column, which is whichever of the two the source actually
-- transmitted. Wire protocol (`protocol`) and transport (`source`) are separate
-- lookup tables, and a new one of either is an INSERT rather than a migration —
-- ALERT and ALERT2 are what the ALERT2 / ERT-A2 tab reads today, HTTP and MQTT
-- are what #B5 and #B6 carry, and none of those four is the last.
--
-- **3. The same reading arrives more than once.** That is what a repeater network
-- *is*: one transmission heard direct and via two repeaters is three copies of
-- one reading. The primary key **is** the dedupe, and the duplicate is counted
-- rather than discarded — how often a reading arrives by three paths is a real
-- diagnostic about the network, and this is the only place it will ever be
-- visible.
--
-- **4. Two timestamps.** When the device says it read (`reading_ts`) and when we
-- received it (`received_at`). ARRO's own CSV carries both and they differ
-- whenever a packet is delayed. Field clocks drift: the receive time is the one
-- you can trust and the reading time is the one that means something.
--
-- **5. Raw values are the truth.** An engineering value is an interpretation laid
-- over the reading, not part of it — the ALERT2 tab says so in as many words.
-- `value_raw` is what was transmitted, `value` is the conversion if we had one,
-- and `conversion` records which one was used. A rainfall count means nothing
-- without the bucket size, and the 357 filter's 3/5/7 thresholds are in counts,
-- not millimetres.
--
-- **6. Retention is designed in, not retrofitted.** #70 has the maths: the whole
-- network at 15-minute reporting is 914k rows/day and fills the free tier inside
-- a week. Raw readings age out, rollups are kept forever, and
-- meganet.retain() is the one job that does it — see the foot of this file and
-- db/README.md.

-- ── The vocabularies ─────────────────────────────────────────────────────────
-- Four small lookup tables rather than four check constraints. The difference
-- matters: a check constraint that has to grow is a migration, and this schema is
-- going to meet protocols and transports nobody has named yet. A row is cheaper
-- than a file, and the smallint codes stay stable in a table with millions of
-- rows pointing at them.
--
-- Each carries a text `key` — that is what a payload sends, because a JSON body
-- saying "mqtt" is readable in a log and a body saying 2 is not — and a smallint
-- `code`, which is what gets stored.

create table if not exists meganet.ingest_source (
  code   smallint primary key,
  key    text     not null unique,
  label  text     not null default ''
);

comment on table meganet.ingest_source is
  'How a reading reached us — the transport, not the wire protocol. New transports are a row here, not a migration.';

insert into meganet.ingest_source (code, key, label) values
  (0, 'unknown',  'Not stated by the adapter'),
  (1, 'http',     'HTTP POST to the ingest endpoint (#B5)'),
  (2, 'mqtt',     'The MQTT bridge (#B6)'),
  (3, 'manual',   'Typed in by a person'),
  (4, 'backfill', 'Loaded from an existing archive — ARRO CSV, a capture file'),
  (5, 'serial',   'Read directly off an ERT-A2 over USB or RS-232')
on conflict (code) do update set key = excluded.key, label = excluded.label;

create table if not exists meganet.protocol (
  code   smallint primary key,
  key    text     not null unique,
  label  text     not null default ''
);

comment on table meganet.protocol is
  'The wire protocol the reading was decoded from, independent of how it reached us. ALERT and ALERT2 are what the ALERT2 / ERT-A2 tab reads; an HTTP POST or an MQTT message will usually be carrying one of them. New protocols are a row here.';

insert into meganet.protocol (code, key, label) values
  (0, 'unknown', 'Not stated by the adapter'),
  (1, 'alert',   'Legacy ALERT — 13-bit address, 11-bit value'),
  (2, 'alert2',  'ALERT2 / ERT-A2'),
  (3, 'arro',    'An ARRO sensor export, backfilled')
on conflict (code) do update set key = excluded.key, label = excluded.label;

create table if not exists meganet.quality (
  code   smallint primary key,
  key    text     not null unique,
  label  text     not null default ''
);

comment on table meganet.quality is
  'What the source says about the reading. 0 is the default and means nobody said otherwise — not that anybody checked.';

insert into meganet.quality (code, key, label) values
  (0, 'unqualified', 'No quality stated by the source'),
  (1, 'good',        'Source asserts the reading is good'),
  (2, 'suspect',     'Source flagged it, or a filter did'),
  (3, 'estimated',   'Interpolated or otherwise not measured'),
  (4, 'bad',         'Source asserts the reading is wrong'),
  (5, 'missing',     'A gap recorded as a gap')
on conflict (code) do update set key = excluded.key, label = excluded.label;

-- Units are validated rather than free text, because "unit known" is the
-- difference between a number and a measurement, and because a typo'd unit is
-- invisible until somebody plots it. Seeded from the sensor types that actually
-- appear in stations.json — Battery, Rainfall, Water Level, Conductivity, pH and
-- the long tail — plus `count`, which is what an untranslated ALERT value is.
create table if not exists meganet.unit (
  key    text primary key,
  label  text not null default ''
);

comment on table meganet.unit is
  'The units a reading may carry. Validated by meganet.ingest(); an unknown unit is a rejected row with a reason, not a mystery string in the data.';

insert into meganet.unit (key, label) values
  ('count',  'Raw counts, as transmitted — bucket tips, level counts'),
  ('mm',     'Millimetres — rainfall'),
  ('m',      'Metres — water level'),
  ('mAHD',   'Metres, Australian Height Datum'),
  ('V',      'Volts — battery'),
  ('mV',     'Millivolts'),
  ('degC',   'Degrees Celsius'),
  ('uS/cm',  'Microsiemens per centimetre — conductivity'),
  ('pH',     'pH units'),
  ('mg/L',   'Milligrams per litre — dissolved oxygen'),
  ('%',      'Per cent — humidity, saturation'),
  ('NTU',    'Nephelometric turbidity units'),
  ('m3/s',   'Cubic metres per second — flow rate'),
  ('ML/d',   'Megalitres per day — flow'),
  ('kPa',    'Kilopascals — gas pressure'),
  ('hPa',    'Hectopascals — barometric pressure'),
  ('km/h',   'Kilometres per hour — wind speed and gust'),
  ('km',     'Kilometres — wind run'),
  ('deg',    'Degrees — wind direction'),
  ('dBm',    'Decibel-milliwatts — received signal'),
  ('s',      'Seconds')
on conflict (key) do update set label = excluded.label;

-- ── The reading ──────────────────────────────────────────────────────────────
-- One table. Everything the network reports lands here, whatever spoke it and
-- however it arrived.
--
-- `addr` is the identity, and it is generated rather than supplied so that it
-- cannot disagree with the columns it is built from. Two shapes:
--
--   a:6128            an ALERT/ALERT2 address. The address *is* the sensor, so
--                     there is no channel — one address is one measurement.
--   s:541155/rain     a station number and a channel. A satellite or cellular
--                     station has no ALERT address; its number names the site,
--                     so the channel is what says which sensor spoke.
--
-- A station may transmit both ways — a site with radio and a satellite backup.
-- Those are two addresses and they do not deduplicate against each other, which
-- is correct: they are two transmissions, and the whole point of `path` and
-- `dup_count` is to be able to see that.
--
-- Note what is *not* a column: nothing here is keyed on `station_id`. That is
-- point 1 at the top of this file, made structural.
create table if not exists meganet.reading (
  -- Exactly one of these two carries the address, and `addr` below decides
  -- which. Both may be present — an adapter that knows the station number as
  -- well as the address is welcome to say so — in which case the ALERT address
  -- wins, because that is what the packet was addressed to.
  alert_id        integer,
  station_number  text,
  -- Which sensor at that station number. Empty for an ALERT-addressed reading,
  -- where the address already answers the question. Whatever the source calls
  -- the channel: a sensor id, a parameter name, a port number.
  channel         text        not null default '',

  addr            text        generated always as (
                    case when alert_id is not null
                         then 'a:' || alert_id
                         else 's:' || coalesce(station_number, '') || '/' || channel
                    end) stored,

  -- Resolved from the address where that is unambiguous, null where it is not,
  -- and backfillable either way — meganet.resolve_readings(). Deliberately no
  -- foreign key: a reading from a station MegaNet has not been told about yet is
  -- exactly the reading we must not drop, and a resolution that happens later
  -- must not be blocked by a station row that was deleted in between.
  station_id      text,

  reading_ts      timestamptz not null,
  received_at     timestamptz not null default now(),

  -- As transmitted, before any interpretation. `numeric` rather than the
  -- `int` #75 sketched, for one reason: a satellite or cellular station has no
  -- counts to send and posts an engineering value directly, and forcing that
  -- through an integer column means either losing the decimals or inventing a
  -- scale factor. An ALERT count stored as numeric is still exactly that count.
  value_raw       numeric     not null,
  -- The conversion, when we had one to apply, and the rule that produced it.
  -- "raw x 0.2 mm per tip (recorded for Durikai)" is the sort of thing that
  -- belongs next to the number rather than in someone's head.
  value           numeric,
  unit            text        references meganet.unit (key),
  conversion      text,

  quality         smallint    not null default 0 references meganet.quality (code),
  protocol        smallint    not null default 0 references meganet.protocol (code),
  source          smallint    not null default 0 references meganet.ingest_source (code),

  -- The repeater or base that delivered the copy we kept, when the adapter knows.
  path            text,
  -- How many further copies arrived, and by which other paths. This is the
  -- repeater-network diagnostic: a reading with dup_count 2 and three distinct
  -- paths was heard direct and via two repeaters, which is the network working.
  dup_count       integer     not null default 0,
  dup_paths       text[]      not null default '{}',
  last_dup_at     timestamptz,

  -- The meganet.reading_raw row this came in on, while that row still exists.
  -- Plain bigint and no foreign key on purpose: raw submissions age out on a
  -- much shorter clock than readings do, and a cascade or a SET NULL would turn
  -- a cheap range delete into an index scan per row. A dangling id means "the
  -- submission has aged out", which is the truth.
  raw_id          bigint,

  constraint reading_addressed check (
    alert_id is not null or nullif(btrim(station_number), '') is not null),
  -- An ALERT address is a sensor, so a channel alongside one would be a second
  -- opinion about identity. ingest() drops it rather than rejecting the row; the
  -- constraint is what stops anything else putting one there.
  constraint reading_radio_has_no_channel check (
    alert_id is null or channel = ''),
  -- 1–65535 is the range the app's own backfill box accepts (app.js ~6309).
  -- Legacy ALERT is 13 bits, 0–8191; ALERT2 is wider. Zero is not an address.
  constraint reading_alert_id_range check (
    alert_id is null or (alert_id between 1 and 65535)),
  -- 'NaN' is a real numeric value and would sit in the primary key comparing
  -- equal to nothing, including itself in some paths. It is never a reading.
  constraint reading_value_is_a_number check (
    value_raw <> 'NaN'::numeric and (value is null or value <> 'NaN'::numeric)),

  -- The dedupe. Same address, same instant, same value = one reading heard
  -- twice; the first is kept and the rest are counted. `value_raw` is in the key
  -- so that a genuine same-second change is not silently eaten.
  primary key (addr, reading_ts, value_raw)
)
-- Room in the page for the duplicate counter to be bumped in place. Every
-- duplicate is an UPDATE of non-indexed columns, so with space to spare it is a
-- HOT update that leaves the primary key alone; without it, a three-path network
-- writes three index entries for every reading.
with (fillfactor = 90);

comment on table meganet.reading is
  'Every field-station reading. The primary key is the deduplication: same address, same instant, same value = one reading heard twice.';
comment on column meganet.reading.addr is
  'The identity. a:<alert address> for radio, s:<station number>/<channel> for satellite or cellular. Generated, so it cannot disagree with its parts.';
comment on column meganet.reading.station_id is
  'Resolved where unambiguous, null where not, backfillable by meganet.resolve_readings(). Never taken from the payload.';
comment on column meganet.reading.reading_ts is
  'When the device says it read. Field clocks drift — this is the one that means something.';
comment on column meganet.reading.received_at is
  'When we got it. This is the one you can trust.';
comment on column meganet.reading.value_raw is
  'As transmitted, before any conversion. An ALERT count, or the engineering value itself for a source that has no counts.';
comment on column meganet.reading.dup_count is
  'How many further copies of this reading arrived. A repeater network delivers most readings more than once; this is where that is visible.';

-- The primary key already indexes (addr, reading_ts), which is the reading
-- lookup. What follows is everything else, chosen with the volume maths in mind
-- — an index on a table heading for millions of rows is a real fraction of the
-- free tier, so each one below earns its place or is not here.
--
-- Two BRIN indexes rather than btrees. `received_at` is exactly insert order and
-- `reading_ts` is very nearly so, which is the case BRIN is for: a few kilobytes
-- instead of tens of megabytes, and both are only ever used for the whole-range
-- scans that roll_up() and retain() do.
create index if not exists reading_received_brin on meganet.reading
  using brin (received_at);
create index if not exists reading_ts_brin on meganet.reading
  using brin (reading_ts);

-- "What did that site report last night?" — the question the epic promises an
-- answer to. Partial, because the unresolved rows are not what it asks about.
create index if not exists reading_station_idx on meganet.reading
  (station_id, reading_ts) where station_id is not null;

-- The backfill's index. Tiny by construction: it only holds rows still waiting
-- to be resolved, and resolving one removes it from the index.
create index if not exists reading_unresolved_idx on meganet.reading
  (addr) where station_id is null;

-- ── The frame exactly as received ────────────────────────────────────────────
-- One row per meganet.ingest() call, holding the payload as it arrived. This
-- whole app is built on being able to see what the filter removed; when a decode
-- looks wrong, the submission is the only way to settle it.
--
-- It ages out on a much shorter clock than readings do — it is a debugging
-- artefact, not a record — and an adapter that knows it is replaying something it
-- already has can turn it off with "keep_raw": false in the envelope.
create table if not exists meganet.reading_raw (
  id           bigint      generated always as identity primary key,
  received_at  timestamptz not null default now(),
  source       smallint    not null default 0 references meganet.ingest_source (code),
  protocol     smallint    not null default 0 references meganet.protocol (code),
  path         text,
  -- What ingest() was handed, unmodified.
  payload      jsonb       not null,
  -- The wire frame behind it, when the adapter has one to give: an ERT-A2 ASCII
  -- line, a hex dump of the binary frame, the MQTT topic and bytes.
  frame        text,
  -- What became of it, filled in as the batch is processed.
  accepted     integer     not null default 0,
  duplicates   integer     not null default 0,
  rejected     integer     not null default 0,
  submitted_by text
);

comment on table meganet.reading_raw is
  'One row per ingest() call, holding the payload exactly as submitted. Ages out on a short clock — see meganet.retain(). Not readable with the anon key: a submission is whatever a device sent, which is not something to publish unread.';

create index if not exists reading_raw_received_brin on meganet.reading_raw
  using brin (received_at);

-- ── The rollups ──────────────────────────────────────────────────────────────
-- What survives when the raw readings age out, and what the reporting tab (#B7)
-- draws when the window is wide. Two tables rather than a materialised view,
-- because they have to be incrementally maintainable and outlive their input.
--
-- Sums rather than means. A mean cannot be re-aggregated — averaging twelve
-- hourly means gives the wrong day whenever the hours have different counts —
-- but a sum can, so the day is built from the hours exactly, and the mean is a
-- generated column over the sum. That is also what lets the daily rollup keep
-- being correct after the readings behind it are gone.
create table if not exists meganet.reading_hourly (
  addr            text        not null,
  bucket          timestamptz not null,
  alert_id        integer,
  station_number  text,
  channel         text,
  station_id      text,
  unit            text,
  n               integer     not null,
  n_dup           integer     not null default 0,
  n_val           integer     not null default 0,
  raw_min         numeric,
  raw_max         numeric,
  raw_sum         numeric,
  raw_last        numeric,
  raw_mean        numeric     generated always as (raw_sum / nullif(n, 0)) stored,
  val_min         numeric,
  val_max         numeric,
  val_sum         numeric,
  val_last        numeric,
  val_mean        numeric     generated always as (val_sum / nullif(n_val, 0)) stored,
  first_ts        timestamptz not null,
  last_ts         timestamptz not null,
  rolled_at       timestamptz not null default now(),
  primary key (addr, bucket)
);

comment on table meganet.reading_hourly is
  'Per address, per hour: count, min, max, sum, last. Kept forever. Rebuilt from meganet.reading by meganet.roll_up().';

create table if not exists meganet.reading_daily (
  addr            text        not null,
  bucket          date        not null,
  alert_id        integer,
  station_number  text,
  channel         text,
  station_id      text,
  unit            text,
  n               integer     not null,
  n_dup           integer     not null default 0,
  n_val           integer     not null default 0,
  raw_min         numeric,
  raw_max         numeric,
  raw_sum         numeric,
  raw_last        numeric,
  raw_mean        numeric     generated always as (raw_sum / nullif(n, 0)) stored,
  val_min         numeric,
  val_max         numeric,
  val_sum         numeric,
  val_last        numeric,
  val_mean        numeric     generated always as (val_sum / nullif(n_val, 0)) stored,
  first_ts        timestamptz not null,
  last_ts         timestamptz not null,
  rolled_at       timestamptz not null default now(),
  primary key (addr, bucket)
);

comment on table meganet.reading_daily is
  'Per address, per day. Built from meganet.reading_hourly, not from the readings, so it stays exact after the readings age out.';

create index if not exists reading_hourly_station_idx on meganet.reading_hourly
  (station_id, bucket) where station_id is not null;
create index if not exists reading_daily_station_idx on meganet.reading_daily
  (station_id, bucket) where station_id is not null;

-- ── Resolving an address to a station ────────────────────────────────────────
-- Unambiguous or nothing. 604 ALERT addresses in the current data are carried by
-- more than one station, and picking one of those by some tiebreaker would be
-- inventing a fact — the ALERT2 tab makes the operator choose for exactly this
-- reason. A null here is honest and is fixed later, either by the address
-- becoming unique or by a person.
create or replace function meganet.resolve_station(p_alert_id integer, p_station_number text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- The ALERT address first: that is what the packet was addressed to. Then the
  -- station number, for the sources that have no ALERT address at all. Each
  -- branch yields a row only when its answer is unique, so the coalesce is a
  -- preference order and not a fallback through an ambiguous match.
  select coalesce(
    (select case when pg_catalog.count(distinct s.station_id) = 1
                 then pg_catalog.min(s.station_id) end
       from meganet.sensor s
       join meganet.station st on st.id = s.station_id and st.deleted_at is null
      where p_alert_id is not null
        and s.alert_id = p_alert_id),
    (select case when pg_catalog.count(*) = 1
                 then pg_catalog.min(st.id) end
       from meganet.station st
      where st.deleted_at is null
        and nullif(pg_catalog.btrim(p_station_number), '') is not null
        and st.station_number = pg_catalog.btrim(p_station_number)));
$$;

comment on function meganet.resolve_station(integer, text) is
  'Which station is this address, when exactly one answer exists? Null otherwise — 604 ALERT addresses are shared, and guessing between them would invent a fact.';

-- ── Reading one value out of a payload ───────────────────────────────────────
-- Small helpers so that "be liberal in what you accept" is written once rather
-- than five times, and so that a bad field produces a sentence rather than a
-- Postgres cast error.

-- Timestamps. ISO 8601 is the contract, but a device speaking MQTT will send
-- epoch seconds and one speaking JavaScript will send milliseconds, and refusing
-- those buys nothing. The 1e11 threshold is the year 5138 in seconds and 1973 in
-- milliseconds, so nothing real is on the wrong side of it.
create or replace function meganet.as_ts(p_value jsonb, p_field text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_num numeric;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    return null;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'number' then
    v_num := (p_value #>> '{}')::numeric;
    if pg_catalog.abs(v_num) >= 1e11 then
      v_num := v_num / 1000;
    end if;
    return pg_catalog.to_timestamp(v_num);
  end if;

  if pg_catalog.jsonb_typeof(p_value) <> 'string' then
    raise exception '% must be a timestamp or an epoch number', p_field
      using errcode = '22007';
  end if;

  begin
    return (p_value #>> '{}')::timestamptz;
  exception when others then
    raise exception '% is not a timestamp: %', p_field, p_value #>> '{}'
      using errcode = '22007';
  end;
end;
$$;

comment on function meganet.as_ts(jsonb, text) is
  'A JSON value as a timestamptz. Accepts ISO 8601, epoch seconds and epoch milliseconds. Raises a sentence, not a cast error.';

-- Numbers. A JSON number, or a string holding one — plenty of devices quote
-- everything. NaN and Infinity are rejected here rather than at the constraint,
-- so the reason comes back naming the field.
create or replace function meganet.as_num(p_value jsonb, p_field text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_txt text;
  v_num numeric;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if pg_catalog.jsonb_typeof(p_value) not in ('number', 'string') then
    raise exception '% must be a number', p_field using errcode = '22P02';
  end if;

  v_txt := pg_catalog.btrim(p_value #>> '{}');
  if v_txt !~ '^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$' then
    raise exception '% is not a number: %', p_field, v_txt using errcode = '22P02';
  end if;

  v_num := v_txt::numeric;
  if v_num <> v_num then                     -- NaN, which is never a reading
    raise exception '% is not a number', p_field using errcode = '22P02';
  end if;
  if pg_catalog.abs(v_num) > 1e12 then
    raise exception '% is out of range: %', p_field, v_txt using errcode = '22003';
  end if;
  return v_num;
end;
$$;

comment on function meganet.as_num(jsonb, text) is
  'A JSON value as a numeric. Accepts numbers and numeric strings; refuses NaN, Infinity and anything past 1e12.';

-- A vocabulary lookup that takes either the key a payload sends or the code the
-- table stores, and says which vocabulary it failed in when it fails.
create or replace function meganet.code_for(p_table text, p_value jsonb, p_field text)
returns smallint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_txt  text;
  v_code smallint;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  v_txt := pg_catalog.lower(pg_catalog.btrim(p_value #>> '{}'));
  if v_txt = '' then
    return null;
  end if;

  execute pg_catalog.format(
    'select code from meganet.%I where key = $1 or code::text = $1', p_table)
    into v_code using v_txt;

  if v_code is null then
    raise exception 'unknown %: %', p_field, v_txt using errcode = '23514';
  end if;
  return v_code;
end;
$$;

comment on function meganet.code_for(text, jsonb, text) is
  'Look a payload value up in one of the small vocabulary tables, by key or by code. Raises naming the field when it is not there.';

-- ── The contract ─────────────────────────────────────────────────────────────
--
--   select meganet.ingest('{
--     "source": "mqtt", "protocol": "alert2", "path": "MOUNT_TABLETOP",
--     "readings": [
--       {"alert_id": 6128, "reading_ts": "2026-08-12T04:15:00Z",
--        "value_raw": 12, "value": 2.4, "unit": "mm",
--        "conversion": "raw x 0.2 mm per tip"},
--       {"station_number": "541155", "channel": "level",
--        "reading_ts": 1786000500, "value_raw": 1.842, "unit": "m"}
--     ]}'::jsonb);
--
--   => {"accepted": 2, "duplicates": 0, "rejected": [], "raw_id": 1}
--
-- Four properties, and each one is a line in #75's acceptance:
--
-- **It takes a batch.** A station that has been offline for a day sends a day of
-- backlog. One HTTP request per reading is not going to be what wakes anyone at
-- 3 am. A bare array is accepted too, and so is a single reading object.
--
-- **One bad row never costs the batch.** Every row is validated and inserted in
-- its own subtransaction, and a failure is a `{i, why}` in the result rather than
-- a rolled-back submission. `i` is the row's index in the array, from zero.
--
-- **A duplicate is a no-op, counted.** Not an error, not a rejection — the
-- reading is already there, and the fact that it arrived again is recorded on it.
--
-- **A malformed envelope is a 400, not a partial accept.** A payload that is not
-- an array or an object with `readings` is the caller misunderstanding the
-- contract, which is a different thing from a device sending one bad reading, and
-- it deserves a different answer.
--
-- It is a plain Postgres function, so MQTT, HTTP, backfill and manual entry share
-- one validator and the whole thing moves inside the corporate network with a
-- pg_dump. That is the reason it is not an Edge Function.
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

      -- Address. One of the two, at least; the ALERT address wins when both are
      -- given, because that is what the packet was addressed to.
      v_alert := null;
      if r ? 'alert_id' and pg_catalog.jsonb_typeof(r -> 'alert_id') <> 'null' then
        v_alert := meganet.as_num(r -> 'alert_id', 'alert_id')::integer;
        if v_alert < 1 or v_alert > 65535 then
          raise exception 'alert_id % is outside 1-65535', v_alert using errcode = '23514';
        end if;
      end if;

      v_sn      := nullif(pg_catalog.btrim(coalesce(r ->> 'station_number', '')), '');
      v_channel := pg_catalog.btrim(coalesce(r ->> 'channel', ''));

      if v_alert is null and v_sn is null then
        raise exception 'no address: a reading needs an alert_id, or a station_number for a station that has none'
          using errcode = '23514';
      end if;
      if v_alert is not null then
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
      -- that can name the station is a client that can name the wrong one.
      v_station := meganet.resolve_station(v_alert, v_sn);

      v_addr := case when v_alert is not null then 'a:' || v_alert
                     else 's:' || coalesce(v_sn, '') || '/' || v_channel end;

      insert into meganet.reading (
        alert_id, station_number, channel, station_id,
        reading_ts, received_at, value_raw, value, unit, conversion,
        quality, protocol, source, path, raw_id)
      values (
        v_alert, v_sn, v_channel, v_station,
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

-- ── Backfilling the station a reading came from ──────────────────────────────
-- An address that matched nothing when the reading arrived — a site added to
-- MegaNet the next morning, an address that stopped being shared — resolves now.
-- Cheap because of the partial index: only unresolved rows are in it, and
-- resolving one takes it out.
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
    select r.ctid, meganet.resolve_station(r.alert_id, r.station_number) as sid
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
  'Fill station_id on readings whose address has since become unambiguous. Safe to run repeatedly.';

-- ── Rolling up ───────────────────────────────────────────────────────────────
-- Recomputes whole buckets rather than adding to them, so running it twice
-- changes nothing and running it after a late arrival gets the right answer. The
-- watermark is on `received_at`, not `reading_ts`: a reading that arrives today
-- for last Tuesday has to move last Tuesday's bucket, and only a receive-time
-- watermark notices that.
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
  --
  -- retain() deletes at `reading_ts < now() - retain_reading_days`, so the oldest
  -- bucket that is certainly still whole is the one *after* the hour that cutoff
  -- falls in — hence the trunc and the extra hour, rather than a round day of
  -- margin, which would refuse to roll up a whole day's worth of live readings
  -- whenever the retention window was set to one or two days.
  --
  -- A backfill older than the horizon still lands in meganet.reading and is
  -- queryable until the next retain(); it just does not rewrite history it can no
  -- longer see whole.
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
    addr, bucket, alert_id, station_number, channel, station_id, unit,
    n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
    val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
  select r.addr,
         pg_catalog.date_trunc('hour', r.reading_ts),
         -- addr determines these, so any row's copy is the value. max() rather
         -- than min() for station_id, so a backfilled row wins over a null.
         pg_catalog.max(r.alert_id),
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
    addr, bucket, alert_id, station_number, channel, station_id, unit,
    n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
    val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
  select h.addr,
         (h.bucket at time zone 'UTC')::date,
         pg_catalog.max(h.alert_id),
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

-- ── Retention ────────────────────────────────────────────────────────────────
-- #70's maths, restated because it is the reason this function exists before the
-- first row does. A reading row with its indexes is roughly 130 bytes; the free
-- tier is 500 MB, so call it 3 million rows before anything else is stored.
--
--   Pilot, 20 stations x 3 sensors x 96 readings/day  =   5,760 rows/day
--   Whole network at 15-minute reporting               = 914,000 rows/day
--
-- The pilot has room to think. The whole network fills the tier in under a week.
-- So raw readings age out and the rollups are kept: an hourly row per address per
-- hour is 3,174 x 3 x 24 = 228k rows/day at full network — no better — but a
-- *daily* row is 9,500/day, which is a decade in the same space.
--
-- Two knobs, both in meganet.app_meta so they can be turned without a migration:
--
--   retain_reading_days      how long meganet.reading keeps a reading  (90)
--   retain_reading_raw_days  how long a submission stays in reading_raw (30)
--
-- **This is the job, and here is where it runs.** For the pilot, by hand:
--
--   psql "$MEGANET_DB_URL" -c 'select meganet.retain()'
--
-- Daily, once there is enough data to matter, from the scheduled workflow next to
-- .github/workflows/acma-refresh.yml, or from pg_cron if the project has it:
--
--   select cron.schedule('meganet-retain', '17 15 * * *', $$select meganet.retain()$$);
--
-- 15:17 UTC is 01:17 in Brisbane, which is after the day has closed and before
-- anyone is looking. Whichever way it is run, it rolls up first and then deletes:
-- the order is not optional, because a reading deleted before it is rolled up is
-- gone from both places.
create or replace function meganet.retain(p_max_rows integer default 200000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reading_days integer;
  v_raw_days     integer;
  v_rolled       jsonb;
  v_del_reading  integer;
  v_del_raw      integer;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to age out readings' using errcode = '42501';
  end if;

  v_reading_days := coalesce((select a.value::integer from meganet.app_meta a
                               where a.key = 'retain_reading_days'), 90);
  v_raw_days     := coalesce((select a.value::integer from meganet.app_meta a
                               where a.key = 'retain_reading_raw_days'), 30);

  -- Roll up first. Always.
  v_rolled := meganet.roll_up();

  -- Capped, so the first run against a table that has been left alone for a year
  -- is a series of bounded deletes rather than one that runs out of disk. The
  -- result says whether there is more to do.
  with doomed as (
    select r.ctid from meganet.reading r
     where r.reading_ts < pg_catalog.now() - v_reading_days * interval '1 day'
     limit greatest(p_max_rows, 0)
  )
  delete from meganet.reading r using doomed d where r.ctid = d.ctid;
  get diagnostics v_del_reading = row_count;

  with doomed as (
    select w.id from meganet.reading_raw w
     where w.received_at < pg_catalog.now() - v_raw_days * interval '1 day'
     limit greatest(p_max_rows, 0)
  )
  delete from meganet.reading_raw w using doomed d where w.id = d.id;
  get diagnostics v_del_raw = row_count;

  return pg_catalog.jsonb_build_object(
    'rolled',            v_rolled,
    'readings_deleted',  v_del_reading,
    'raw_deleted',       v_del_raw,
    'reading_days',      v_reading_days,
    'raw_days',          v_raw_days,
    'more', (v_del_reading >= p_max_rows or v_del_raw >= p_max_rows));
end;
$$;

comment on function meganet.retain(integer) is
  'Roll up, then age out. Deletes readings older than app_meta.retain_reading_days and submissions older than retain_reading_raw_days. Bounded per call; "more" says whether to run it again.';

insert into meganet.app_meta (key, value) values
  ('retain_reading_days',     '90'),
  ('retain_reading_raw_days', '30')
on conflict (key) do nothing;

-- ── Row level security ───────────────────────────────────────────────────────
-- Every table above, in this file, per db/README.md. Supabase's rls_auto_enable
-- event trigger only covers `public`; ours is `meganet` and nothing catches this
-- for us.
--
-- Readings are public. The station list is, the ALERT2 tab publishes decoded
-- captures, and a river height is not a secret.
--
-- meganet.reading_raw is the one exception, and deliberately so: it holds
-- whatever a device or an adapter actually sent, unread. That is a debugging
-- artefact rather than a publication, and the day an adapter includes a header
-- or a device key in its payload is the day the difference matters. Editors and
-- the service key can read it; the anon key cannot.
alter table meganet.reading         enable row level security;
alter table meganet.reading_raw     enable row level security;
alter table meganet.reading_hourly  enable row level security;
alter table meganet.reading_daily   enable row level security;
alter table meganet.ingest_source   enable row level security;
alter table meganet.protocol        enable row level security;
alter table meganet.quality         enable row level security;
alter table meganet.unit            enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['reading', 'reading_hourly', 'reading_daily',
                           'ingest_source', 'protocol', 'quality', 'unit'] loop
    execute pg_catalog.format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for select using (true)', t || '_read_all', t);
  end loop;
end
$$;

drop policy if exists reading_raw_read_editors on meganet.reading_raw;
create policy reading_raw_read_editors on meganet.reading_raw
  for select to authenticated
  using (meganet.is_editor());

-- The second lock, as in 0004. The functions above are `security definer` and so
-- run past these; they are what stands between a future `grant insert … to
-- authenticated` and an open readings table.
do $$
declare
  t text;
  v text;
begin
  foreach t in array array['reading', 'reading_raw', 'reading_hourly', 'reading_daily'] loop
    foreach v in array array['insert', 'update', 'delete'] loop
      execute pg_catalog.format('drop policy if exists %I on meganet.%I', t || '_' || v || '_editors', t);
    end loop;
    execute pg_catalog.format(
      'create policy %I on meganet.%I for insert to authenticated
         with check (meganet.is_editor())', t || '_insert_editors', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for update to authenticated
         using (meganet.is_editor()) with check (meganet.is_editor())',
      t || '_update_editors', t);
    execute pg_catalog.format(
      'create policy %I on meganet.%I for delete to authenticated
         using (meganet.is_editor())', t || '_delete_editors', t);
  end loop;
end
$$;

-- ── Who may run what ─────────────────────────────────────────────────────────
-- Postgres hands EXECUTE on every new function to PUBLIC, and four of these
-- write, so the default is revoked explicitly — see db/README.md.
--
-- **ingest() is not granted to `anon`, and that is the whole security story of
-- this file.** A grant to anon would make a table with millions of rows writable
-- by anyone holding a key that is committed to a public repo. Today ingest runs
-- as an editor or with the service key, which is enough for a backfill, for
-- manual entry, and for a bridge process holding a server-side secret. Giving a
-- *device* its own credential is #B5's problem and needs a per-device key with a
-- scope narrower than "editor" — not a loosened grant here.
revoke all on function meganet.ingest(jsonb)                        from public;
revoke all on function meganet.resolve_readings(integer)            from public;
revoke all on function meganet.roll_up(timestamptz)                 from public;
revoke all on function meganet.retain(integer)                      from public;
revoke all on function meganet.resolve_station(integer, text)       from public;
revoke all on function meganet.as_ts(jsonb, text)                   from public;
revoke all on function meganet.as_num(jsonb, text)                  from public;
revoke all on function meganet.code_for(text, jsonb, text)          from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.reading, meganet.reading_hourly, meganet.reading_daily,
                  meganet.ingest_source, meganet.protocol, meganet.quality, meganet.unit
    to anon, authenticated;
  grant select on meganet.reading_raw to authenticated;
  grant select, insert, update, delete
    on meganet.reading, meganet.reading_raw, meganet.reading_hourly,
       meganet.reading_daily, meganet.ingest_source, meganet.protocol,
       meganet.quality, meganet.unit
    to service_role;

  grant execute on function meganet.ingest(jsonb)             to authenticated, service_role;
  grant execute on function meganet.resolve_readings(integer) to authenticated, service_role;
  grant execute on function meganet.roll_up(timestamptz)      to authenticated, service_role;
  grant execute on function meganet.retain(integer)           to authenticated, service_role;
  grant execute on function meganet.resolve_station(integer, text) to anon, authenticated, service_role;
  grant execute on function meganet.as_ts(jsonb, text)        to authenticated, service_role;
  grant execute on function meganet.as_num(jsonb, text)       to authenticated, service_role;
  grant execute on function meganet.code_for(text, jsonb, text) to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '6')
on conflict (key) do update set value = excluded.value;
