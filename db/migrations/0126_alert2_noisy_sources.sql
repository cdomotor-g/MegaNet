-- 0126_alert2_noisy_sources.sql — An ALERT2 concentrator that relays noise:
-- what it repacks is held back, and what it already put in is taken out.
--
-- Why this file exists
-- ────────────────────
-- Bohle River AL (Townsville) had 26 readings in Flood-Net, all ALERT2 on
-- 151.5375 MHz at one base station's receiver — 300 km past anything that
-- could hear it. None came from Bohle River. Each was a legacy ALERT report
-- that an ALERT2 *concentrator* — a site that listens for old-style ALERT
-- bursts and repacks them into its own ALERT2 messages — had put in a
-- message as heard. The concentrator is ALERT2 source 33300 (Dumbleton Rocks
-- AL's station number, near Mackay), heard first-hand on 151.5375.
--
-- Its legacy receiver decodes noise. Measured on the live receptions,
-- 25–26 November 2026 (two days):
--
--   source   legacy reports   addresses   on the register   address bits set (of 13)
--   33300         173,077        5,700         55.8 %              9.7
--   11762          20,848          527         96.5 %              6.7
--   11099           2,044           84         97.2 %              6.5
--   legacy direct  49,461            —         71.4 %              —
--
-- 5,142 of the 8,191 legacy addresses are on the register (63 %): a report
-- made of random bits lands on a register station about that often, and
-- 33300's do. Its addresses lean to ones (8191, 8190, 7671 …), values to 2047
-- — the marks a demodulator hears in a quiet channel. Bohle River's battery
-- read 76, 1983, 1072 counts on three days. ALERT2's own error checks then
-- carry each one to us perfectly: nothing at our end can see the damage,
-- because it was done before the last hop.
--
-- It is most of what that channel stores. On 25 November 18,338 of the
-- 21,629 ALERT2-relayed legacy readings (85 %) came only from 33300, 8,959
-- of them put down to register stations — 1,052 stations were "heard" only
-- through it in those two days. Since at least 19 October (carrier_daily),
-- 15,000–50,000 a day.
--
-- What changes
-- ────────────
--   1. meganet.a2_source_hold: the ALERT2 sources whose relayed legacy
--      reports are not stored, each with why. 33300 first. Public to read —
--      a source number and a reason, nothing private. Administrators add and
--      lift one with hold_a2_source() / release_a2_source().
--   2. meganet.a2_relay_sources(frame, alert_id, value): the ALERT2 sources a
--      receiver's frame text says relayed that report — RPi ALERT's
--      "SDR,ALERT2,<id>,<value>,src=<n>,…" lines. A reading's own a2_source,
--      when a sender gives one, is taken over the frame.
--   3. meganet.hold_noisy_relays(envelope): moves every legacy-in-ALERT2
--      reading that only held sources relayed out of `readings` into `held`.
--      ingest_http() calls it first, so a held report does not count as the
--      station heard either (station_status); ingest() calls it too, for
--      every other caller. Held readings stay in reading_raw's payload (under
--      `held`) and in meganet.reception, so the evidence is kept 30 days. The
--      answer gains `held`: how many. Not refusals: the sender did nothing
--      wrong, so they are not in `rejected`.
--      ingest() and ingest_http() are restated in full from 0121 and 0052;
--      only the call and the count are new.
--   4. The readings already stored from 33300 alone are deleted — those
--      whose raw submission still exists (30 days) and that nothing else
--      heard (dup_count 0), on days not yet released by retain(). Their
--      hourly and daily rollups are rebuilt, and station_status is worked out
--      again for every station and address they touched. Older ones (before
--      the raw rows' horizon, about 28 October) cannot be told apart and stay.
--      An archived day whose count changes is archived again as its next
--      version (0073); the old version keeps what was there.
--
-- What it does not do
-- ───────────────────
-- It does not judge a report on its own bits or value: a real station can
-- read 2047. Nor does it catch a good concentrator's occasional bad copy
-- (a single flipped bit) — Station Health's flips do that. It holds a source
-- a person decided to hold, on evidence; tools/check_a2_noisy_sources.sql
-- proves it, and docs/station-health.md's "Noisy concentrators" says how to
-- judge another.

-- ── 1. The held sources ─────────────────────────────────────────────────────

create table if not exists meganet.a2_source_hold (
  a2_source  integer     primary key check (a2_source between 1 and 65535),
  reason     text        not null check (pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 1000),
  held_at    timestamptz not null default pg_catalog.now(),
  held_by    text
);

comment on table meganet.a2_source_hold is
  'ALERT2 sources whose relayed legacy ALERT reports are not stored as readings (0126): a concentrator whose legacy receiver decodes noise. Kept as receptions and in reading_raw. Public to read; administrators write it through hold_a2_source() and release_a2_source().';

alter table meganet.a2_source_hold enable row level security;
drop policy if exists a2_source_hold_read on meganet.a2_source_hold;
create policy a2_source_hold_read on meganet.a2_source_hold for select to anon, authenticated using (true);
revoke all on meganet.a2_source_hold from public;
grant select on meganet.a2_source_hold to anon, authenticated;

insert into meganet.a2_source_hold (a2_source, reason, held_by)
values (33300,
  'Relays noise: 25–26 Nov 2026, 173,077 legacy reports on 5,700 addresses, 55.8 % on the register (random bits give 63 %), '
  || 'addresses averaging 9.7 of 13 bits set; real concentrators 95–98 %, 6.5–6.7 bits. Bohle River AL''s 26 readings were its.',
  '0126')
on conflict (a2_source) do nothing;

-- ── 2. Which sources relayed a report, from the frame text ─────────────────

create or replace function meganet.a2_relay_sources(p_frame text, p_alert integer, p_value bigint)
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct m[1]::integer), '{}'::integer[])
    from pg_catalog.regexp_matches(coalesce(p_frame, ''),
           '(?:^|\n)SDR,ALERT2,' || p_alert::text || ',' || p_value::text || ',src=([0-9]{1,5})(?=[,\r\n]|$)', 'g') as m
   where p_alert is not null and p_value is not null;
$$;

comment on function meganet.a2_relay_sources(text, integer, bigint) is
  'The ALERT2 sources a receiver''s frame text says relayed the legacy report <alert_id> = <value> (RPi ALERT''s "SDR,ALERT2,<id>,<value>,src=<n>" lines; 0126). Empty when no line matches.';

-- ── 3. Holding a batch's noisy relays back ─────────────────────────────────

create or replace function meganet.hold_noisy_relays(p_env jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_frame text;
  v_proto text;
  v_keep  jsonb := '[]'::jsonb;
  v_held  jsonb := '[]'::jsonb;
  v_srcs  integer[];
  r       jsonb;
begin
  if p_env is null or pg_catalog.jsonb_typeof(p_env) <> 'object'
     or pg_catalog.jsonb_typeof(p_env -> 'readings') <> 'array'
     or not exists (select 1 from meganet.a2_source_hold) then
    return p_env;
  end if;
  v_frame := coalesce(p_env ->> 'frame', '');

  for r in select value from pg_catalog.jsonb_array_elements(p_env -> 'readings') loop
    v_srcs := '{}'::integer[];
    if pg_catalog.jsonb_typeof(r) = 'object' and coalesce(r ->> 'alert_id', '') ~ '^[0-9]{1,5}$' then
      v_proto := pg_catalog.lower(coalesce(r ->> 'protocol', p_env ->> 'protocol', ''));
      if v_proto in ('alert2', '2') then
        if coalesce(r ->> 'a2_source', '') ~ '^[0-9]{1,5}$' then
          v_srcs := array[(r ->> 'a2_source')::integer];
        elsif v_frame <> '' and coalesce(r ->> 'value_raw', '') ~ '^[0-9]{1,9}$' then
          v_srcs := meganet.a2_relay_sources(v_frame, (r ->> 'alert_id')::integer, (r ->> 'value_raw')::bigint);
        end if;
      end if;
    end if;
    -- Held only when every source that relayed it is held: a report a good
    -- concentrator relayed too is a real one.
    if pg_catalog.cardinality(v_srcs) > 0
       and not exists (select 1 from pg_catalog.unnest(v_srcs) s(src)
                        where s.src not in (select h.a2_source from meganet.a2_source_hold h)) then
      v_held := v_held || pg_catalog.jsonb_build_array(r || pg_catalog.jsonb_build_object('held_a2_source', pg_catalog.to_jsonb(v_srcs)));
    else
      v_keep := v_keep || pg_catalog.jsonb_build_array(r);
    end if;
  end loop;

  if pg_catalog.jsonb_array_length(v_held) = 0 then
    return p_env;
  end if;
  return p_env || pg_catalog.jsonb_build_object(
    'readings', v_keep,
    'held', coalesce(case when pg_catalog.jsonb_typeof(p_env -> 'held') = 'array' then p_env -> 'held' end, '[]'::jsonb) || v_held);
end;
$$;

comment on function meganet.hold_noisy_relays(jsonb) is
  'Moves every legacy-in-ALERT2 reading of an envelope that only sources on meganet.a2_source_hold relayed out of readings into held (0126). Called first by ingest_http() and by ingest().';

revoke all on function meganet.hold_noisy_relays(jsonb) from public;
revoke all on function meganet.a2_relay_sources(text, integer, bigint) from public;
grant execute on function meganet.a2_relay_sources(text, integer, bigint) to anon, authenticated;

create or replace function meganet.hold_a2_source(p_source integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator holds an ALERT2 source' using errcode = '42501';
  end if;
  if p_source is null or p_source < 1 or p_source > 65535 then
    raise exception 'an ALERT2 source is 1–65535' using errcode = '22023';
  end if;
  if pg_catalog.length(pg_catalog.btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'say why: the reason is what the next person reads' using errcode = '22023';
  end if;
  insert into meganet.a2_source_hold (a2_source, reason, held_by)
  values (p_source, pg_catalog.left(pg_catalog.btrim(p_reason), 1000), meganet.actor())
  on conflict (a2_source) do update set reason = excluded.reason, held_by = excluded.held_by, held_at = pg_catalog.now();
end;
$$;

create or replace function meganet.release_a2_source(p_source integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator lifts a hold on an ALERT2 source' using errcode = '42501';
  end if;
  delete from meganet.a2_source_hold where a2_source = p_source;
  return found;
end;
$$;

revoke all on function meganet.hold_a2_source(integer, text) from public;
revoke all on function meganet.release_a2_source(integer) from public;
grant execute on function meganet.hold_a2_source(integer, text) to authenticated;
grant execute on function meganet.release_a2_source(integer) to authenticated;

-- ── 3a. ingest(), restated in full from 0121 ───────────────────────────────
-- New: hold_noisy_relays() on an envelope, and `held` in the answer.

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

  -- What only a held ALERT2 concentrator relayed is not stored (0126): moved
  -- out of `readings` into `held`. The submission below keeps it whole.
  if pg_catalog.jsonb_typeof(v_env -> 'readings') = 'array' then
    v_env  := meganet.hold_noisy_relays(v_env);
    v_rows := v_env -> 'readings';
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
           'held',       coalesce(pg_catalog.jsonb_array_length(
                           case when pg_catalog.jsonb_typeof(v_env -> 'held') = 'array' then v_env -> 'held' end), 0),
           'raw_id',     v_raw_id);
end;
$$;

-- ── 3b. ingest_http(), restated in full from 0052 ──────────────────────────
-- New: hold_noisy_relays() first. create or replace keeps its grants (0012).

create or replace function meganet.ingest_http(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_id  bigint;
  v_env       jsonb;
  v_readings  jsonb;
  v_result    jsonb;
  v_raw_id    bigint;
  v_now       timestamptz;
  v_n         integer;
  v_backfill  boolean;
  c_max_batch constant integer := 1000;
begin
  -- The token: 0008's check, PT401 for a missing, unknown or revoked one.
  v_token_id := meganet.ingest_token_id();

  -- A device retrying a timeout deserves a clear refusal, not another timeout.
  v_n := case
           when pg_catalog.jsonb_typeof(payload) = 'array'
             then pg_catalog.jsonb_array_length(payload)
           when pg_catalog.jsonb_typeof(payload) = 'object' and payload ? 'readings'
                and pg_catalog.jsonb_typeof(payload -> 'readings') = 'array'
             then pg_catalog.jsonb_array_length(payload -> 'readings')
           else 1
         end;
  if v_n > c_max_batch then
    raise exception
      'batch of % exceeds the %-reading limit — split it into more than one POST',
      v_n, c_max_batch
      using errcode = '22023';
  end if;

  v_env := case when pg_catalog.jsonb_typeof(payload) = 'object' then payload
                else pg_catalog.jsonb_build_object('readings', payload) end;
  if not v_env ? 'source' then
    v_env := v_env || pg_catalog.jsonb_build_object('source', 'http');
  end if;

  -- What only a held ALERT2 concentrator relayed is held back here, before
  -- ingest() and before "heard from" below, so it does not count as the
  -- station heard either (0126).
  v_env := meganet.hold_noisy_relays(v_env);

  -- Authorises the one ingest() call that follows, and names the ingest point
  -- for the rows it writes; both transaction-local, both after the token check.
  perform pg_catalog.set_config('meganet.ingest_authorized', 'true', true);
  perform pg_catalog.set_config('meganet.ingest_token_id', v_token_id::text, true);

  v_result := meganet.ingest(v_env);

  -- ── Who has been heard from, and when ──────────────────────────────────────
  -- Bookkeeping about readings already stored: a failure here is a warning in
  -- the server log, never an accepted batch lost (a subtransaction; ingest()'s
  -- work survives its rollback).
  begin
    v_now := pg_catalog.now();
    v_backfill := pg_catalog.lower(coalesce(v_env ->> 'source', '')) = 'backfill';

    v_readings := case
      when pg_catalog.jsonb_typeof(v_env -> 'readings') = 'array' then v_env -> 'readings'
      when pg_catalog.jsonb_typeof(v_env) = 'object' then pg_catalog.jsonb_build_array(v_env)
      else '[]'::jsonb end;

    -- Heard from: every address in the batch, whether or not its reading passed
    -- validation, at when it was heard (0052) — its own time, no later than now;
    -- now for a dead clock's time, which says nothing about when.
    insert into meganet.station_status as ss
      (station_key, station_id, last_seen_at, updated_at)
    select k.key, pg_catalog.max(k.sid), pg_catalog.max(k.heard), v_now
      from (
        select coalesce(s.sid,
                        case when s.aid is not null then 'a:' || s.aid
                             else 's:' || s.snum end) as key,
               s.sid,
               case
                 when s.ts is null or s.ts < '1990-01-01'::timestamptz or s.ts > v_now + interval '1 day' then v_now
                 when s.ts < v_now - interval '90 days' and not s.backfill then v_now
                 else least(s.ts, v_now)
               end as heard
          from (
            select meganet.resolve_station(a.aid, a.snum) as sid, a.aid, a.snum, a.ts, a.backfill
              from (
                select case when r ->> 'alert_id' ~ '^[0-9]+$'
                            then (r ->> 'alert_id')::integer end as aid,
                       nullif(pg_catalog.btrim(coalesce(r ->> 'station_number', '')), '') as snum,
                       meganet.as_ts_or_null(r -> 'reading_ts') as ts,
                       case when r ? 'source' then pg_catalog.lower(coalesce(r ->> 'source', '')) = 'backfill'
                            else v_backfill end as backfill
                  from pg_catalog.jsonb_array_elements(v_readings) as r
                 where pg_catalog.jsonb_typeof(r) = 'object'
              ) a
             where a.aid is not null or a.snum is not null
          ) s
      ) k
     -- station_status_key_shape refuses these, and a batch must not die on one.
     where k.key is not null and k.key <> '' and k.key !~ '[+#/]'
     group by k.key
    on conflict (station_key) do update set
      last_seen_at = greatest(ss.last_seen_at, excluded.last_seen_at),
      station_id   = coalesce(ss.station_id, excluded.station_id),
      updated_at   = v_now;

    -- Stored: the rows ingest() actually kept, which it links to its raw row.
    v_raw_id := case when pg_catalog.jsonb_typeof(v_result -> 'raw_id') = 'number'
                     then (v_result ->> 'raw_id')::bigint end;

    if v_raw_id is not null then
      insert into meganet.station_status as ss
        (station_key, station_id, last_reading_at, updated_at)
      select k.key, pg_catalog.max(k.sid), pg_catalog.max(k.ts), v_now
        from (
          select coalesce(r.station_id,
                          case when r.alert_id is not null then 'a:' || r.alert_id
                               else 's:' || coalesce(r.station_number, '') end) as key,
                 r.station_id as sid,
                 r.reading_ts as ts
            from meganet.reading r
           where r.raw_id = v_raw_id
        ) k
       where k.key is not null and k.key <> '' and k.key !~ '[+#/]'
       group by k.key
      on conflict (station_key) do update set
        last_reading_at = greatest(ss.last_reading_at, excluded.last_reading_at),
        station_id      = coalesce(ss.station_id, excluded.station_id),
        updated_at      = v_now;
    end if;
  exception when others then
    -- sqlstate and sqlerrm are plpgsql's own variables: bare, not qualified.
    raise warning 'ingest_http: station_status not updated for token % (%): %',
                  v_token_id, sqlstate, sqlerrm;
  end;

  return v_result;
end;
$$;

-- ── 4. Taking out what a held source already put in ────────────────────────
-- take_out_held_relays(): every stored ALERT2-relayed legacy reading whose
-- submission's frame names only held sources for it, that nothing else heard
-- (dup_count 0), on a day retain() has not begun releasing — deleted, its
-- hourly and daily rollups rebuilt (as 0098 rebuilds them), and
-- station_status worked out again for every station and address it touched:
-- its newest reading that is left. An address nobody is on record for, left
-- with no reading at all, loses its row: noise made it. One pass over the
-- ALERT2 readings, so the service key's: run once below, and again after an
-- administrator holds another source.

create or replace function meganet.take_out_held_relays()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
  v_s integer;
begin
  drop table if exists pg_temp._held_rows, pg_temp._roll_hours, pg_temp._roll_days,
                       pg_temp._held_keys, pg_temp._held_last;

  create temporary table _held_rows on commit drop as
  select r.addr, r.reading_ts, r.value_raw, r.station_id, r.alert_id
    from meganet.reading r
    join meganet.reading_raw w on w.id = r.raw_id
   where r.protocol = 2
     and r.alert_id is not null
     and r.dup_count = 0
     and r.value_raw = pg_catalog.trunc(r.value_raw)
     and r.value_raw between 0 and 999999999
     and w.frame is not null
     and not exists (select 1 from meganet.archive_day a
                      where a.table_name = 'reading' and a.day = (r.reading_ts at time zone 'UTC')::date
                        and a.released_at is not null)
     and (select pg_catalog.cardinality(x.s) > 0
                 and x.s <@ (select pg_catalog.array_agg(h.a2_source) from meganet.a2_source_hold h)
            from (select meganet.a2_relay_sources(w.frame, r.alert_id, r.value_raw::bigint) as s) x);

  delete from meganet.reading r
   using pg_temp._held_rows g
   where r.addr = g.addr and r.reading_ts = g.reading_ts and r.value_raw = g.value_raw;

  -- The rollups those rows were counted in (as 0098 rebuilds them).


  create temporary table _roll_hours on commit drop as select distinct addr, pg_catalog.date_trunc('hour', reading_ts) as bucket from pg_temp._held_rows;

  delete from meganet.reading_hourly h
   using pg_temp._roll_hours t
   where h.addr = t.addr and h.bucket = t.bucket;

  insert into meganet.reading_hourly (
    addr, bucket, alert_id, a2_station, a2_sensor, station_number, channel,
    station_id, unit,
    n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
    val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
  select r.addr,
         pg_catalog.date_trunc('hour', r.reading_ts),
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
      on h.addr = r.addr and r.reading_ts >= h.bucket and r.reading_ts < h.bucket + interval '1 hour'
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

  create temporary table _roll_days on commit drop as
  select distinct t.addr, (t.bucket at time zone 'UTC')::date as day
    from pg_temp._roll_hours t;

  delete from meganet.reading_daily d
   using pg_temp._roll_days t
   where d.addr = t.addr and d.bucket = t.day;

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
    from pg_temp._roll_days d
    join meganet.reading_hourly h
      on h.addr = d.addr
     and h.bucket >= (d.day::timestamp at time zone 'UTC')
     and h.bucket <  ((d.day + 1)::timestamp at time zone 'UTC')
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

  -- station_status, again, for every station and address those rows touched:
  -- its newest reading that is left. last_seen_at follows it — a held report
  -- set it, and nothing else heard is on record to keep it later.

  create temporary table _held_keys on commit drop as
  select distinct coalesce(g.station_id, 'a:' || g.alert_id) as station_key, g.station_id, g.addr
    from pg_temp._held_rows g;

  create temporary table _held_last on commit drop as
  select k.station_key,
         (select pg_catalog.max(r.reading_ts) from meganet.reading r
           where (k.station_id is not null and r.station_id = k.station_id)
              or (k.station_id is null and r.addr = k.addr)) as last_ts
    from (select distinct on (station_key) station_key, station_id, addr from pg_temp._held_keys) k;

  -- An address nobody is on record for, left with no reading at all: its row
  -- was made by noise.
  delete from meganet.station_status ss
   using pg_temp._held_last l
   where ss.station_key = l.station_key and ss.station_id is null and l.last_ts is null
     and ss.station_key like 'a:%';

  update meganet.station_status ss
     set last_reading_at = l.last_ts,
         last_seen_at    = case when l.last_ts is null then null
                                else least(ss.last_seen_at, l.last_ts) end,
         updated_at      = pg_catalog.now()
    from pg_temp._held_last l
   where ss.station_key = l.station_key
     and (ss.last_reading_at is distinct from l.last_ts or ss.last_seen_at > l.last_ts);

  select pg_catalog.count(*), pg_catalog.count(distinct station_id) into v_n, v_s from pg_temp._held_rows;
  return pg_catalog.jsonb_build_object('readings', v_n, 'stations', v_s);
end;
$fn$;

comment on function meganet.take_out_held_relays() is
  'Deletes the stored readings that only sources on meganet.a2_source_hold relayed (as their reading_raw frame says), nothing else heard, on days not yet released; rebuilds their rollups and station_status (0126). The service key''s.';

revoke all on function meganet.take_out_held_relays() from public;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function meganet.take_out_held_relays() to service_role;
  end if;
end
$$;

do $$
declare v jsonb;
begin
  v := meganet.take_out_held_relays();
  raise notice '0126: % readings relayed only by held ALERT2 sources taken out (% register stations)',
    v ->> 'readings', v ->> 'stations';
end
$$;

-- ── Checks ──────────────────────────────────────────────────────────────────

do $$
declare v jsonb;
begin
  if not exists (select 1 from meganet.a2_source_hold where a2_source = 33300) then
    raise exception '0126 did not take: 33300 is not held';
  end if;
  if meganet.a2_relay_sources(E'SDR,ALERT2,2723,76,src=33300,stamp=4221,before=58,mhz=151.5375\nSDR,ALERT2,2723,76,src=11762,path=11056-10019', 2723, 76)
       <> array[11762, 33300] then
    raise exception '0126 did not take: a2_relay_sources does not read the frame';
  end if;
  if meganet.a2_relay_sources('SDR,ALERT2,27231,76,src=33300', 2723, 76) <> '{}'::integer[]
     or meganet.a2_relay_sources('SDR,ALERT2,2723,761,src=33300', 2723, 76) <> '{}'::integer[] then
    raise exception '0126 did not take: a2_relay_sources matches a longer address or value';
  end if;
  v := meganet.hold_noisy_relays(jsonb_build_object('protocol', 'alert2',
         'frame', E'SDR,ALERT2,2723,76,src=33300\nSDR,ALERT2,4001,5,src=11762,path=1',
         'readings', jsonb_build_array(jsonb_build_object('alert_id', 2723, 'value_raw', 76),
                                       jsonb_build_object('alert_id', 4001, 'value_raw', 5))));
  if pg_catalog.jsonb_array_length(v -> 'readings') <> 1 or pg_catalog.jsonb_array_length(v -> 'held') <> 1
     or (v -> 'readings' -> 0 ->> 'alert_id') <> '4001' then
    raise exception '0126 did not take: hold_noisy_relays does not split a batch';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.ingest(jsonb)'::regprocedure) not like '%hold_noisy_relays%'
     or pg_catalog.pg_get_functiondef('meganet.ingest(jsonb)'::regprocedure) not like '%resolve_a2_sensor%' then
    raise exception '0126 did not take: ingest() does not hold noisy relays, or lost 0121';
  end if;
  if pg_catalog.pg_get_functiondef('meganet.ingest_http(jsonb)'::regprocedure) not like '%hold_noisy_relays%'
     or pg_catalog.pg_get_functiondef('meganet.ingest_http(jsonb)'::regprocedure) not like '%last_seen_at%' then
    raise exception '0126 did not take: ingest_http() does not hold noisy relays first, or lost 0052';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 125 → 126 once this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '126')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
