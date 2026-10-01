-- 0045_ingest_points.sql — A browser can be a base station, and it says what it
-- is and roughly where.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0045_ingest_points.sql
--
-- Why this file exists
-- ────────────────────
-- The Serial Monitor's three receivers — a Quansheng radio on the ALERT
-- receiver firmware, an ELPRO ERT-A2, an RTL-SDR stick — decode readings in the
-- browser, and the computer they are plugged into is exactly what
-- docs/ingest-http.md calls an ingest point: "a PC on the end of a serial
-- cable". So the cards post through the door every base station uses,
-- meganet.ingest_http(), holding an ingest token like any other, with source
-- 'serial' (0006's vocabulary already has it). Nothing about a reading changes,
-- and this file does not touch ingest(), ingest_http() or the reading table.
--
-- What a token cannot say is what is behind it. A token names the computer —
-- one per ingest point, as the page says — but one computer can have several
-- receivers on it, and a laptop moves. Two things record that:
--
--   1. Each reading's `path` (0006: provenance, free text) carries the
--      receiver, as `serial-monitor/<point_id>`. ingest() already keeps the
--      path a reading first came by and up to eight more it was heard on as
--      dup_paths, so two receivers hearing the same ALERT2 frame are both on
--      the record without a single new column.
--   2. meganet.ingest_point_report — what each receiver says about itself: its
--      name, the kind of receiver, the device's details, and where it is.
--      Written only through meganet.report_ingest_point(), token-checked like
--      the bridge's heartbeat (0008). A report that changes anything is a new
--      row; one that repeats the last moves its last_seen_at. So a laptop that
--      moved is a new row, and one that did not is not a new row a minute.
--
-- Location, and saying how good it is
-- ───────────────────────────────────
-- None of these receivers has a GPS today. A location comes from the browser
-- (Wi-Fi or IP, at whatever accuracy the browser admits to), from a station the
-- operator says the receiver sits at, from coordinates typed in, or from the
-- stations it hears — and every one of those is approximate. `location_approx`
-- says so on the row, `location_source` says which of them it was, and a
-- constraint holds it: only a location whose source is 'gps' may be marked
-- exact. When GPS hardware arrives it reports 'gps' and nothing here changes.
-- A receiver that knows nowhere says 'none', with no coordinates — a fact we do
-- not have rather than one we invented.
--
-- Who can read it: editors, not anon. A receiver on a laptop reports where the
-- laptop is, which may be somebody's house. The readings themselves stay
-- public as they always were; their `path` names a receiver id, not a place.

-- ── The reports ──────────────────────────────────────────────────────────────

create table if not exists meganet.ingest_point_report (
  id               bigint           generated always as identity primary key,
  ingest_token_id  bigint           not null references meganet.ingest_token (id),
  -- The label the token had when this was reported — kept here because the
  -- token table is readable by nobody, and "which computer" is the first thing
  -- anyone reading this will ask.
  token_label      text             not null default '',
  -- Which receiver behind that token: the id the browser made up once and keeps
  -- (localStorage), and the one each reading's path carries.
  point_id         text             not null,
  name             text             not null,
  receiver         text             not null,
  detail           jsonb            not null default '{}'::jsonb,

  lat              double precision,
  lon              double precision,
  accuracy_m       double precision,
  location_source  text             not null,
  location_approx  boolean          not null,
  location_note    text,
  -- The station the operator says the receiver sits at, when they said one.
  -- No foreign key, for the reason station_status has none (0008): a report is
  -- a record of what was said, and the function nulls an id it cannot find.
  host_station_id  text,

  reported_at      timestamptz      not null default now(),
  last_seen_at     timestamptz      not null default now(),

  constraint ingest_point_report_point_shape check (point_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint ingest_point_report_name_len    check (pg_catalog.length(name) between 1 and 120),
  constraint ingest_point_report_receiver    check (receiver in ('quansheng', 'ert-a2', 'rtl-sdr', 'serial')),
  constraint ingest_point_report_source      check (location_source in ('gps', 'browser', 'manual', 'station', 'heard', 'none')),
  -- The rule this table exists to keep: nothing but a GPS fix may call itself exact.
  constraint ingest_point_report_only_gps_exact check (location_approx or location_source = 'gps'),
  constraint ingest_point_report_where       check ((location_source = 'none') = (lat is null)
                                                    and (lat is null) = (lon is null)),
  constraint ingest_point_report_lat         check (lat is null or lat between -90 and 90),
  constraint ingest_point_report_lon         check (lon is null or lon between -180 and 180),
  constraint ingest_point_report_accuracy    check (accuracy_m is null or accuracy_m >= 0),
  constraint ingest_point_report_note_len    check (location_note is null or pg_catalog.length(location_note) <= 300),
  constraint ingest_point_report_detail      check (pg_catalog.jsonb_typeof(detail) = 'object'
                                                    and pg_catalog.octet_length(detail::text) <= 4096)
);

comment on table meganet.ingest_point_report is
  'What each receiver behind an ingest token says about itself — name, kind, device, and where it is, with how that location was got. A new row when anything changes; last_seen_at moves on a repeat. Written only by meganet.report_ingest_point(). Readable by editors only: a laptop''s location can be somebody''s house.';
comment on column meganet.ingest_point_report.point_id is
  'The receiver''s own id, kept by the browser. Each reading it posts carries path = ''serial-monitor/'' || point_id.';
comment on column meganet.ingest_point_report.location_source is
  'gps (a fix from GPS hardware — the only exact one), browser (the browser''s geolocation: Wi-Fi or IP), manual (typed in), station (the station the operator says it sits at), heard (worked out from the stations it hears), none.';
comment on column meganet.ingest_point_report.location_approx is
  'True unless location_source is gps — held by a constraint, so an approximate location can never be stored as an exact one.';
comment on column meganet.ingest_point_report.accuracy_m is
  'The radius the source claims, in metres, where it claims one (the browser does). Null is not "exact" — it is "not stated".';

create index if not exists ingest_point_report_point_idx
  on meganet.ingest_point_report (ingest_token_id, point_id, reported_at desc);

alter table meganet.ingest_point_report enable row level security;
drop policy if exists ingest_point_report_read_editors on meganet.ingest_point_report;
create policy ingest_point_report_read_editors on meganet.ingest_point_report
  for select to authenticated
  using (meganet.is_editor());

-- The latest report per receiver: what is behind each token now.
create or replace view meganet.ingest_point_latest
with (security_invoker = true) as
  select distinct on (ingest_token_id, point_id)
         id, ingest_token_id, token_label, point_id, name, receiver, detail,
         lat, lon, accuracy_m, location_source, location_approx, location_note,
         host_station_id, reported_at, last_seen_at
    from meganet.ingest_point_report
   order by ingest_token_id, point_id, reported_at desc, id desc;

comment on view meganet.ingest_point_latest is
  'The latest report from each receiver behind each ingest token. security_invoker, so it reads as the editor-only table under it does.';

-- ── The door ─────────────────────────────────────────────────────────────────
-- Token-checked exactly as bridge_heartbeat() is (0008): ingest_token_id()
-- raises PT401 for a missing, unknown or revoked token. A bad report is a 22023
-- naming the field, because the caller is a person setting a card up, not a
-- logger that will retry the same mistake forever.

create or replace function meganet.report_ingest_point(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token    bigint;
  v_label    text;
  v_point    text;
  v_name     text;
  v_recv     text;
  v_detail   jsonb;
  v_lat      double precision;
  v_lon      double precision;
  v_acc      double precision;
  v_src      text;
  v_approx   boolean;
  v_note     text;
  v_host     text;
  v_last     meganet.ingest_point_report;
  v_id       bigint;
  v_repeat   boolean := false;
begin
  v_token := meganet.ingest_token_id();

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'report_ingest_point takes an object, got %',
                    coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;

  v_point := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(payload ->> 'point_id', '')), ''));
  if v_point is null or v_point !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception 'point_id must be 3-64 characters of a-z, 0-9, dot, dash or underscore, got %',
                    coalesce(payload ->> 'point_id', 'nothing')
      using errcode = '22023';
  end if;

  v_name := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(payload ->> 'name', '')), ''), 120);
  if v_name is null then v_name := v_point; end if;

  v_recv := pg_catalog.lower(coalesce(payload ->> 'receiver', ''));
  if v_recv not in ('quansheng', 'ert-a2', 'rtl-sdr', 'serial') then
    raise exception 'receiver must be quansheng, ert-a2, rtl-sdr or serial, got %', coalesce(payload ->> 'receiver', 'nothing')
      using errcode = '22023';
  end if;

  v_detail := case when pg_catalog.jsonb_typeof(payload -> 'detail') = 'object'
                   then payload -> 'detail' else '{}'::jsonb end;
  if pg_catalog.octet_length(v_detail::text) > 4096 then
    raise exception 'detail is % bytes; 4096 is the most a report may carry', pg_catalog.octet_length(v_detail::text)
      using errcode = '22023';
  end if;

  v_src := pg_catalog.lower(coalesce(payload ->> 'location_source', 'none'));
  if v_src not in ('gps', 'browser', 'manual', 'station', 'heard', 'none') then
    raise exception 'location_source must be gps, browser, manual, station, heard or none, got %', v_src
      using errcode = '22023';
  end if;

  if v_src <> 'none' then
    if coalesce(pg_catalog.jsonb_typeof(payload -> 'lat'), '') <> 'number'
       or coalesce(pg_catalog.jsonb_typeof(payload -> 'lon'), '') <> 'number' then
      raise exception 'a location from % needs lat and lon as numbers', v_src using errcode = '22023';
    end if;
    v_lat := (payload ->> 'lat')::double precision;
    v_lon := (payload ->> 'lon')::double precision;
    if v_lat not between -90 and 90 or v_lon not between -180 and 180 then
      raise exception 'lat %, lon % is not a place on Earth', v_lat, v_lon using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(payload -> 'accuracy_m') = 'number' and (payload ->> 'accuracy_m')::double precision >= 0 then
      v_acc := (payload ->> 'accuracy_m')::double precision;
    end if;
  end if;

  -- Whatever the caller says, nothing but GPS is exact. Said by the caller as
  -- false for a browser location, it is stored as true — the constraint would
  -- refuse the row otherwise, and refusing a whole report over a flag the
  -- database can set correctly itself helps nobody.
  v_approx := case when v_src <> 'gps' then true
                   when pg_catalog.jsonb_typeof(payload -> 'location_approx') = 'boolean'
                     then (payload ->> 'location_approx')::boolean
                   else false end;

  v_note := pg_catalog.left(nullif(pg_catalog.btrim(coalesce(payload ->> 'location_note', '')), ''), 300);

  v_host := nullif(pg_catalog.btrim(coalesce(payload ->> 'host_station_id', '')), '');
  if v_host is not null and not exists (select 1 from meganet.station s where s.id = v_host) then
    v_host := null;
  end if;

  select t.label into v_label from meganet.ingest_token t where t.id = v_token;

  -- Same as the last report from this receiver? Then it is a heartbeat.
  select * into v_last
    from meganet.ingest_point_report r
   where r.ingest_token_id = v_token and r.point_id = v_point
   order by r.reported_at desc, r.id desc
   limit 1;

  if v_last.id is not null
     and v_last.name = v_name and v_last.receiver = v_recv and v_last.detail = v_detail
     and v_last.location_source = v_src and v_last.location_approx = v_approx
     and v_last.lat is not distinct from v_lat and v_last.lon is not distinct from v_lon
     and v_last.accuracy_m is not distinct from v_acc
     and v_last.location_note is not distinct from v_note
     and v_last.host_station_id is not distinct from v_host then
    update meganet.ingest_point_report set last_seen_at = pg_catalog.now() where id = v_last.id;
    v_id := v_last.id;
    v_repeat := true;
  else
    insert into meganet.ingest_point_report
      (ingest_token_id, token_label, point_id, name, receiver, detail,
       lat, lon, accuracy_m, location_source, location_approx, location_note, host_station_id)
    values
      (v_token, coalesce(v_label, ''), v_point, v_name, v_recv, v_detail,
       v_lat, v_lon, v_acc, v_src, v_approx, v_note, v_host)
    returning id into v_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', v_id, 'label', coalesce(v_label, ''), 'point_id', v_point,
    'path', 'serial-monitor/' || v_point,
    'location_source', v_src, 'location_approx', v_approx,
    'repeat', v_repeat, 'at', pg_catalog.now());
end;
$$;

comment on function meganet.report_ingest_point(jsonb) is
  'A receiver behind an ingest token says what and where it is (0045): name, kind, device detail, and a location with its source — approximate unless the source is gps. Token-checked like bridge_heartbeat(). Returns the token''s label, so the browser can show which ingest point it is posting as.';

-- ── Who may run what ─────────────────────────────────────────────────────────
-- EXECUTE defaults to PUBLIC on a new function, so it is revoked and granted by
-- name. Granted to anon for the reason ingest_http() is: the token, not the
-- role, is what authorises it.

revoke all on function meganet.report_ingest_point(jsonb) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.ingest_point_report to authenticated, service_role;
  grant select on meganet.ingest_point_latest to authenticated, service_role;
  grant execute on function meganet.report_ingest_point(jsonb) to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('meganet.ingest_point_report') is null then
    raise exception '0045 did not take: no meganet.ingest_point_report';
  end if;
  if to_regprocedure('meganet.report_ingest_point(jsonb)') is null then
    raise exception '0045 did not take: no meganet.report_ingest_point(jsonb)';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'ingest_point_report_only_gps_exact') then
    raise exception '0045 did not take: nothing stops an approximate location being stored as exact';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 44 → 45 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '45')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
