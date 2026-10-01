-- 0047_receptions.sql — Every frame a receiver heard, good or bad, with where
-- it was: the Reception Map's raw material, kept.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0047_receptions.sql
--
-- Why this file exists
-- ────────────────────
-- A reading is a value kept once: the same address, time and value stored once
-- whoever heard it (0006). That is right for the data and wrong for finding a
-- transmitter that corrupts what it relays, because the corrupted copy is
-- exactly what deduplication and validation throw away — or, worse, store as a
-- reading from some other station. A reception is one receiver hearing one
-- frame once, bad or good, at a signal level, from a place. reception.js
-- analyses them; reception-log.js records them in the browser; this keeps them,
-- so a drive in a vehicle and a week at a fixed site can be put side by side.
--
-- Shape: one row per frame heard, from a receiver behind an ingest token (0045:
-- the token names the computer, point_id the receiver). Written only through
-- meganet.report_receptions(), token-checked like everything else that ingest
-- points call; a retried batch stores nothing twice (the receiver, the moment,
-- the address and the payload are the identity). Position as 0045 records it:
-- source and accuracy, and only a GPS fix may be stored as exact.
--
-- Who can read it: editors, through meganet.reception_window() or the table
-- under RLS. A vehicle's receptions are a record of where the vehicle went.
--
-- Not done here: retention. Receptions are small and a drive is a few thousand
-- rows; when there are enough to matter, meganet.retain() learns about them.

create table if not exists meganet.reception (
  id               bigint           generated always as identity primary key,
  ingest_token_id  bigint           not null references meganet.ingest_token (id),
  point_id         text             not null,
  receiver         text             not null,
  heard_at         timestamptz      not null,
  received_at      timestamptz      not null default now(),
  protocol         text,
  alert_id         integer,
  value_raw        integer,
  payload_hex      text,
  ok               boolean          not null,
  fault            text,
  rssi_dbm         real,
  level_dbfs       real,
  nf_dbm           real,
  votes            smallint,
  lat              double precision,
  lon              double precision,
  accuracy_m       real,
  location_source  text             not null default 'none',
  location_approx  boolean          not null default true,
  speed_mps        real,
  heading_deg      real,
  detail           jsonb            not null default '{}'::jsonb,

  constraint reception_point_shape check (point_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint reception_receiver    check (receiver in ('quansheng', 'ert-a2', 'rtl-sdr', 'serial')),
  constraint reception_protocol    check (protocol is null or protocol in ('alert', 'alert2')),
  constraint reception_alert_id    check (alert_id is null or alert_id between 0 and 65535),
  constraint reception_value       check (value_raw is null or value_raw between 0 and 65535),
  constraint reception_payload     check (payload_hex is null or payload_hex ~ '^[0-9A-Fa-f]{1,64}$'),
  constraint reception_fault       check (fault is null or fault in ('rejected', 'undecoded', 'shadow', 'status', 'frame', 'crc')),
  constraint reception_ok_fault    check (not (ok and fault is not null)),
  constraint reception_source      check (location_source in ('gps', 'browser', 'manual', 'station', 'heard', 'none')),
  constraint reception_only_gps_exact check (location_approx or location_source = 'gps'),
  constraint reception_where       check ((location_source = 'none') = (lat is null) and (lat is null) = (lon is null)),
  constraint reception_lat         check (lat is null or lat between -90 and 90),
  constraint reception_lon         check (lon is null or lon between -180 and 180),
  constraint reception_detail      check (pg_catalog.jsonb_typeof(detail) = 'object' and pg_catalog.octet_length(detail::text) <= 2048)
);

comment on table meganet.reception is
  'Every frame a receiver heard, good or bad, with its level and where the receiver was (0047) — the Reception Map''s raw material, kept because deduplicated readings throw away exactly the corrupted copies that find a bad repeater. Written only by meganet.report_receptions(); readable by editors only.';
comment on column meganet.reception.fault is
  'Why a reception is bad, when the receiver said so: rejected (the radio heard it and did not report it), undecoded (a burst nothing came out of), shadow (a decoder''s bit-flip shadow), status / frame (an ERT-A2''s flags), crc. A copy that decoded cleanly but is not what was sent is found by the analysis, not stored as a fault.';
comment on column meganet.reception.location_approx is
  'True unless location_source is gps — held by a constraint, as in ingest_point_report (0045).';

create unique index if not exists reception_identity
  on meganet.reception (ingest_token_id, point_id, heard_at, coalesce(alert_id, -1), coalesce(payload_hex, ''), coalesce(value_raw, -1), ok);
create index if not exists reception_alert_idx on meganet.reception (alert_id, heard_at);
create index if not exists reception_heard_brin on meganet.reception using brin (heard_at);

alter table meganet.reception enable row level security;
drop policy if exists reception_read_editors on meganet.reception;
create policy reception_read_editors on meganet.reception
  for select to authenticated
  using (meganet.is_editor());

-- ── The door ─────────────────────────────────────────────────────────────────
-- { point_id, receiver, receptions: [ … ] }, at most 1,000. Each row checked on
-- its own: a bad one comes back in `rejected` with its index and why, and the
-- rest are stored — ingest_http()'s contract, for the same reason.

create or replace function meganet.report_receptions(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token    bigint;
  v_point    text;
  v_recv     text;
  v_rows     jsonb;
  r          jsonb;
  i          integer := -1;
  v_ok       integer := 0;
  v_dup      integer := 0;
  v_rej      jsonb := '[]'::jsonb;
  v_at       timestamptz;
  v_src      text;
  v_lat      double precision;
  v_lon      double precision;
  v_n        integer;
begin
  v_token := meganet.ingest_token_id();
  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'report_receptions takes an object' using errcode = '22023';
  end if;
  v_point := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(payload ->> 'point_id', '')), ''));
  if v_point is null or v_point !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception 'point_id must be 3-64 characters of a-z, 0-9, dot, dash or underscore' using errcode = '22023';
  end if;
  v_recv := pg_catalog.lower(coalesce(payload ->> 'receiver', ''));
  if v_recv not in ('quansheng', 'ert-a2', 'rtl-sdr', 'serial') then
    raise exception 'receiver must be quansheng, ert-a2, rtl-sdr or serial' using errcode = '22023';
  end if;
  v_rows := payload -> 'receptions';
  if pg_catalog.jsonb_typeof(v_rows) <> 'array' then
    raise exception 'receptions must be an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_rows) > 1000 then
    raise exception 'batch of % exceeds the 1000-reception limit — split it', pg_catalog.jsonb_array_length(v_rows) using errcode = '22023';
  end if;

  for r in select * from pg_catalog.jsonb_array_elements(v_rows) loop
    i := i + 1;
    begin
      v_at := meganet.as_ts(r -> 'heard_at', 'heard_at');
      if v_at is null then raise exception 'heard_at is missing'; end if;
      if v_at < '1990-01-01' then raise exception 'heard_at % is before 1990 — a dead clock', v_at; end if;
      if v_at > pg_catalog.now() + interval '1 day' then raise exception 'heard_at % is more than a day in the future', v_at; end if;
      v_src := pg_catalog.lower(coalesce(r ->> 'location_source', 'none'));
      if v_src not in ('gps', 'browser', 'manual', 'station', 'heard', 'none') then raise exception 'unknown location_source %', v_src; end if;
      v_lat := case when pg_catalog.jsonb_typeof(r -> 'lat') = 'number' then (r ->> 'lat')::double precision end;
      v_lon := case when pg_catalog.jsonb_typeof(r -> 'lon') = 'number' then (r ->> 'lon')::double precision end;
      if v_lat is null or v_lon is null then v_src := 'none'; v_lat := null; v_lon := null; end if;
      if v_src = 'none' then v_lat := null; v_lon := null; end if;

      insert into meganet.reception
        (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, payload_hex, ok, fault,
         rssi_dbm, level_dbfs, nf_dbm, votes, lat, lon, accuracy_m, location_source, location_approx, speed_mps, heading_deg, detail)
      values
        (v_token, v_point, v_recv, v_at,
         nullif(r ->> 'protocol', ''),
         case when pg_catalog.jsonb_typeof(r -> 'alert_id') = 'number' then (r ->> 'alert_id')::integer end,
         case when pg_catalog.jsonb_typeof(r -> 'value_raw') = 'number' then (r ->> 'value_raw')::integer end,
         nullif(r ->> 'payload_hex', ''),
         coalesce((r ->> 'ok')::boolean, false),
         nullif(r ->> 'fault', ''),
         case when pg_catalog.jsonb_typeof(r -> 'rssi_dbm') = 'number' then (r ->> 'rssi_dbm')::real end,
         case when pg_catalog.jsonb_typeof(r -> 'level_dbfs') = 'number' then (r ->> 'level_dbfs')::real end,
         case when pg_catalog.jsonb_typeof(r -> 'nf_dbm') = 'number' then (r ->> 'nf_dbm')::real end,
         case when pg_catalog.jsonb_typeof(r -> 'votes') = 'number' then (r ->> 'votes')::smallint end,
         v_lat, v_lon,
         case when pg_catalog.jsonb_typeof(r -> 'accuracy_m') = 'number' then (r ->> 'accuracy_m')::real end,
         v_src,
         -- Only GPS may be exact, whatever the caller says.
         v_src <> 'gps',
         case when pg_catalog.jsonb_typeof(r -> 'speed_mps') = 'number' then (r ->> 'speed_mps')::real end,
         case when pg_catalog.jsonb_typeof(r -> 'heading_deg') = 'number' then (r ->> 'heading_deg')::real end,
         case when pg_catalog.jsonb_typeof(r -> 'detail') = 'object' and pg_catalog.octet_length((r -> 'detail')::text) <= 2048 then r -> 'detail' else '{}'::jsonb end)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      if v_n = 1 then v_ok := v_ok + 1; else v_dup := v_dup + 1; end if;
    exception when others then
      v_rej := v_rej || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('i', i, 'why', sqlerrm));
    end;
  end loop;

  return pg_catalog.jsonb_build_object('accepted', v_ok, 'duplicates', v_dup, 'rejected', v_rej);
end;
$$;

comment on function meganet.report_receptions(jsonb) is
  'A receiver posts what it heard (0047): { point_id, receiver, receptions: [...] }, at most 1,000, each row checked on its own. Token-checked like report_ingest_point(); a retried batch stores nothing twice; only a GPS position is stored as exact.';

-- Editors read a window of it, for the Reception Map.
create or replace function meganet.reception_window(p_from timestamptz, p_to timestamptz default now(), p_limit integer default 20000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_editor() then
    raise exception 'receptions are for editors' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'heard_at', x.heard_at, 'receiver', x.receiver, 'point_id', x.point_id,
             'point_name', coalesce(p.name, x.point_id), 'token_label', t.label,
             'protocol', x.protocol, 'alert_id', x.alert_id, 'value_raw', x.value_raw, 'payload_hex', x.payload_hex,
             'ok', x.ok, 'fault', x.fault, 'rssi_dbm', x.rssi_dbm, 'level_dbfs', x.level_dbfs, 'nf_dbm', x.nf_dbm,
             'votes', x.votes, 'lat', x.lat, 'lon', x.lon, 'accuracy_m', x.accuracy_m,
             'location_source', x.location_source, 'location_approx', x.location_approx,
             'speed_mps', x.speed_mps, 'heading_deg', x.heading_deg, 'detail', x.detail)
           order by x.heard_at)
      from (select * from meganet.reception
             where heard_at >= p_from and heard_at <= coalesce(p_to, pg_catalog.now())
             order by heard_at desc
             limit greatest(1, least(coalesce(p_limit, 20000), 50000))) x
      join meganet.ingest_token t on t.id = x.ingest_token_id
      left join meganet.ingest_point_latest p on p.ingest_token_id = x.ingest_token_id and p.point_id = x.point_id
  ), '[]'::jsonb);
end;
$$;

comment on function meganet.reception_window(timestamptz, timestamptz, integer) is
  'Receptions heard between two moments, newest first up to the limit (at most 50,000), oldest first in the answer, with each receiver''s name and its token''s label — for the Reception Map (0047). Editors only.';

revoke all on function meganet.report_receptions(jsonb) from public;
revoke all on function meganet.reception_window(timestamptz, timestamptz, integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.reception to authenticated, service_role;
  grant execute on function meganet.report_receptions(jsonb) to anon, authenticated, service_role;
  grant execute on function meganet.reception_window(timestamptz, timestamptz, integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

do $$
begin
  if to_regclass('meganet.reception') is null or to_regprocedure('meganet.report_receptions(jsonb)') is null
     or to_regprocedure('meganet.reception_window(timestamptz, timestamptz, integer)') is null then
    raise exception '0047 did not take';
  end if;
end
$$;

-- DB_SCHEMA_VERSION in core.js goes 46 → 47 in the same commit as this file.
insert into meganet.app_meta (key, value)
values ('schema_version', '47')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
