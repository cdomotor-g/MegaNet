-- 0068_base_station_spectrum.sql — A waterfall of what a base station's
-- radios hear, on the Base Stations tab: a spectrum row per SDR stick with
-- each check-in.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0068_base_station_spectrum.sql
--
-- Why this file exists
-- ────────────────────
-- A base station with an RTL-SDR stick works out the stick's spectrum once a
-- second anyway — its decoders need it — and its own web page draws it as a
-- spectrum and a waterfall. Nobody off site could see either: the page is on
-- the station's network, and opening it from afar needs a way in that a hut
-- on a hill does not have. Whether a channel is busy, a stick deaf, a
-- neighbour's transmitter splattering across the band, is exactly what an
-- administrator wants to look at from here.
--
-- Sending the page's own picture would cost a Pi with little to spare, and
-- needs no such thing: the station keeps, for each stick, the strongest each
-- of its 256 spectrum bins has been since its last check-in and sends that
-- row with it — a byte a bin, in half-dB steps over the row's own floor,
-- about 350 bytes of base64 a stick (RPi ALERT 0.13.5). A minute a row
-- normally, five seconds while an administrator has the station open. Stacked
-- up, the rows are a waterfall: lagging, and coarse, but the real thing.
--
-- Three decisions.
--
-- **1. The check-in carries it, and never fails over it.** `spectra` is one
-- more key in the payload base_station_checkin() already takes (and a Flood-Net
-- before this file ignores). At most eight rows a check-in, one a stick in any
-- four seconds; a row that does not fit is left out, without a word, so a
-- station on a newer or older format still checks in. Two days are kept.
--
-- **2. Administrators only, like everything else about a base station.**
-- base_station_spectrum has RLS on, no policy and no grant;
-- admin_base_station_spectrum() reads it, behind admin_require(). Nothing in a
-- row is secret, but nothing about a base station is public either.
--
-- **3. The window decides the detail.** One function serves an hour, six or a
-- day, at most 360 rows a stick: the rows in each slice of time (ten seconds
-- for an hour, a minute for six, four for a day) folded into one, each bin
-- the strongest it was. Beside them, the receptions the station sent (0047)
-- in the same slices, by frequency: how many bursts, how many decoded, how
-- many ALERT2, the best signal — what the waterfall marks on top, since a
-- spectrum of a few short looks a second can miss a burst the decoders heard.
-- `p_since` asks for the slices from then on, so a panel left open polls for
-- the newest few, not the day.
--
-- Depends on 0049 (base stations) and 0047 (receptions).
-- tools/check_base_stations.sql proves it.

-- ── The rows ─────────────────────────────────────────────────────────────────

create table if not exists meganet.base_station_spectrum (
  id               bigint       generated always as identity primary key,
  ingest_token_id  bigint       not null references meganet.ingest_token (id),
  -- The stick, as the station's status names it (its receivers' key).
  rx_key           text         not null,
  -- When the row arrived: the end of what it covers.
  at               timestamptz  not null default now(),
  -- How long it covers, back from `at`.
  span_s           integer      not null,
  -- What the stick was tuned to: the middle of the row, and its width.
  center_hz        bigint       not null,
  rate             integer      not null,
  -- The row's floor (its quietest fifth), in the stick's own dB.
  floor_db         real,
  -- A byte a bin, lowest frequency first: half-dB steps over floor_db.
  bins             bytea        not null,

  constraint base_station_spectrum_key    check (pg_catalog.length(rx_key) between 1 and 80),
  constraint base_station_spectrum_span   check (span_s between 1 and 3600),
  constraint base_station_spectrum_center check (center_hz between 1000000 and 6000000000),
  constraint base_station_spectrum_rate   check (rate between 1000 and 20000000),
  constraint base_station_spectrum_floor  check (floor_db is null or floor_db between -200 and 100),
  constraint base_station_spectrum_bins   check (pg_catalog.octet_length(bins) between 16 and 1024)
);

comment on table meganet.base_station_spectrum is
  'Each SDR stick''s spectrum, a row a check-in (0068): the strongest each bin was since the last, in half-dB steps over the row''s floor — what the Base Stations tab stacks into a waterfall. Two days kept. RLS on, no policy and no grant: written by base_station_checkin(), read through admin_base_station_spectrum().';

create index if not exists base_station_spectrum_station_idx
  on meganet.base_station_spectrum (ingest_token_id, at);

alter table meganet.base_station_spectrum enable row level security;

-- ── The door a base station checks in at, with its spectra ───────────────────
-- 0049's, and one more key (decision 1):
--   "spectra": [{"key", "center_hz", "rate", "span_s", "floor_db", "bins"}]
-- bins in base64. Everything else is as it was.

create or replace function meganet.base_station_checkin(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token    bigint;
  v_mode     text;
  v_idle     integer;
  v_status   jsonb;
  v_beat     jsonb;
  v_results  jsonb;
  v_keys     text;
  v_r        jsonb;
  v_row      meganet.base_station;
  v_cmds     jsonb := '[]'::jsonb;
  v_watch    boolean;
  v_label    text;
  v_s        jsonb;
  v_key      text;
  v_bins     bytea;
begin
  v_token := meganet.ingest_token_id();   -- PT401 for a missing, unknown or revoked token

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'base_station_checkin takes an object, got %', coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;
  if coalesce(payload ->> 'v', '1') <> '1' then
    raise exception 'this MegaNet takes check-ins of version 1, not %', pg_catalog.left(payload ->> 'v', 10)
      using errcode = '22023';
  end if;

  v_mode := coalesce(payload ->> 'mode', 'manage');
  if v_mode not in ('manage', 'report', 'off') then
    raise exception 'mode is manage, report or off, not %', pg_catalog.left(v_mode, 20) using errcode = '22023';
  end if;
  v_idle := case when pg_catalog.jsonb_typeof(payload -> 'idle_s') = 'number'
                 then greatest(30, least(900, pg_catalog.round((payload ->> 'idle_s')::numeric)::integer)) else 60 end;

  v_status := nullif(payload -> 'status', 'null'::jsonb);
  if v_status is not null and (pg_catalog.jsonb_typeof(v_status) <> 'object' or pg_catalog.octet_length(v_status::text) > 16384) then
    raise exception 'status is an object of at most 16 KB' using errcode = '22023';
  end if;
  v_beat := nullif(payload -> 'beat', 'null'::jsonb);
  if v_beat is not null and (pg_catalog.jsonb_typeof(v_beat) <> 'object' or pg_catalog.octet_length(v_beat::text) > 2048) then
    raise exception 'beat is an object of at most 2 KB' using errcode = '22023';
  end if;
  v_results := nullif(payload -> 'results', 'null'::jsonb);
  if v_results is not null and (pg_catalog.jsonb_typeof(v_results) <> 'array' or pg_catalog.jsonb_array_length(v_results) > 20) then
    raise exception 'results is a list of at most 20 answers' using errcode = '22023';
  end if;
  v_keys := pg_catalog.left(nullif(payload ->> 'keys_hash', ''), 128);

  insert into meganet.base_station as b
    (ingest_token_id, app, version, mode, idle_s, status, status_at, beat, beat_at, last_seen_at, checkins, keys_hash)
  values
    (v_token, pg_catalog.left(payload -> 'agent' ->> 'app', 40), pg_catalog.left(payload -> 'agent' ->> 'version', 40),
     v_mode, v_idle, v_status, case when v_status is not null then pg_catalog.now() end,
     v_beat, case when v_beat is not null then pg_catalog.now() end, pg_catalog.now(), 1, v_keys)
  on conflict (ingest_token_id) do update set
    app          = coalesce(excluded.app, b.app),
    version      = coalesce(excluded.version, b.version),
    mode         = excluded.mode,
    idle_s       = excluded.idle_s,
    status       = coalesce(excluded.status, b.status),
    status_at    = coalesce(excluded.status_at, b.status_at),
    beat         = coalesce(excluded.beat, b.beat),
    beat_at      = coalesce(excluded.beat_at, b.beat_at),
    last_seen_at = pg_catalog.now(),
    checkins     = b.checkins + 1,
    keys_hash    = coalesce(excluded.keys_hash, b.keys_hash),
    want_status  = case when excluded.status is not null then false else b.want_status end
  returning * into v_row;

  -- The answers to what was handed over — this station's own requests only.
  for v_r in select * from pg_catalog.jsonb_array_elements(coalesce(v_results, '[]'::jsonb)) loop
    continue when pg_catalog.jsonb_typeof(v_r) <> 'object' or pg_catalog.jsonb_typeof(v_r -> 'id') <> 'number';
    continue when (v_r ->> 'id')::numeric not between 1 and 9000000000000000000;
    update meganet.base_station_command c
       set status  = case when v_r -> 'ok' = 'true'::jsonb then 'done' else 'failed' end,
           result  = case when v_r -> 'result' is null then null
                          when pg_catalog.octet_length((v_r -> 'result')::text) <= 65536 then nullif(v_r -> 'result', 'null'::jsonb)
                          else pg_catalog.jsonb_build_object('truncated', true) end,
           error   = pg_catalog.left(v_r ->> 'error', 1000),
           done_at = pg_catalog.now()
     where c.id = (v_r ->> 'id')::numeric::bigint
       and c.ingest_token_id = v_token
       and c.status in ('sent', 'queued');
  end loop;

  if v_mode = 'manage' then
    -- Handed over once, ten at a time, oldest first.
    with picked as (
      select c.id from meganet.base_station_command c
       where c.ingest_token_id = v_token and c.status = 'queued' and c.expires_at > pg_catalog.now()
       order by c.id
       limit 10
       for update skip locked),
    handed as (
      update meganet.base_station_command c
         set status = 'sent', sent_at = pg_catalog.now()
        from picked where c.id = picked.id
      returning c.id, c.verb, c.args)
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', h.id, 'verb', h.verb, 'args', h.args) order by h.id), '[]'::jsonb)
      into v_cmds from handed h;
  else
    -- Decision 3: a station that only reports, or has turned this off, is never
    -- handed a request; anything waiting fails now, saying why.
    update meganet.base_station_command c
       set status = 'failed', done_at = pg_catalog.now(),
           error = case v_mode when 'report' then 'the base station only reports — its owner has turned requests off'
                               else 'the base station has turned remote management off' end
     where c.ingest_token_id = v_token and c.status = 'queued';
  end if;

  -- Housekeeping, this station's own: requests a quarter of a year old.
  delete from meganet.base_station_command c
   where c.ingest_token_id = v_token and c.created_at < pg_catalog.now() - interval '90 days';

  -- Each SDR stick's spectrum since the last check-in (0068): a row a stick,
  -- at most eight. Never the reason a check-in fails — a row that does not
  -- fit (not base64, a number that is not one, outside the table's checks) is
  -- left out, and so is one within four seconds of the stick's last.
  if pg_catalog.jsonb_typeof(payload -> 'spectra') = 'array' then
    for v_s in select e.value from pg_catalog.jsonb_array_elements(payload -> 'spectra') with ordinality as e(value, n) where e.n <= 8 loop
      begin
        continue when pg_catalog.jsonb_typeof(v_s) <> 'object' or pg_catalog.jsonb_typeof(v_s -> 'bins') <> 'string';
        v_key := pg_catalog.left(v_s ->> 'key', 80);
        v_bins := pg_catalog.decode(v_s ->> 'bins', 'base64');
        continue when exists (select 1 from meganet.base_station_spectrum p
                               where p.ingest_token_id = v_token and p.rx_key = v_key and p.at > pg_catalog.now() - interval '4 seconds');
        insert into meganet.base_station_spectrum (ingest_token_id, rx_key, at, span_s, center_hz, rate, floor_db, bins)
        values (v_token, v_key, pg_catalog.now(),
                greatest(1, least(3600, pg_catalog.round((v_s ->> 'span_s')::numeric)::integer)),
                pg_catalog.round((v_s ->> 'center_hz')::numeric)::bigint,
                pg_catalog.round((v_s ->> 'rate')::numeric)::integer,
                (v_s ->> 'floor_db')::real, v_bins);
      exception when others then
        null;
      end;
    end loop;
    -- Housekeeping again: two days of rows a stick is the waterfall's reach.
    delete from meganet.base_station_spectrum p
     where p.ingest_token_id = v_token and p.at < pg_catalog.now() - interval '2 days';
  end if;

  v_watch := v_row.watch_until is not null and v_row.watch_until > pg_catalog.now();
  select t.label into v_label from meganet.ingest_token t where t.id = v_token;

  return pg_catalog.jsonb_build_object(
    'next_s',      case when v_mode = 'off' then null
                        when v_watch then 5
                        when exists (select 1 from meganet.base_station_command c
                                      where c.ingest_token_id = v_token and c.status = 'queued' and c.expires_at > pg_catalog.now()) then 2
                        else v_idle end,
    'watch',       v_watch,
    'want_status', v_row.want_status,
    'commands',    v_cmds,
    'keys_hash',   meganet.base_station_keys_hash(),
    'label',       v_label,
    'at',          pg_catalog.now());
end;
$$;

comment on function meganet.base_station_checkin(jsonb) is
  'A base station checks in (0049): token-checked like report_ingest_point(); records its heartbeat, its whole status when it sends one, its mode, the answers to what it was asked and (0068) each SDR stick''s spectrum row; hands over up to ten requests (to a station that manages — a reporting one''s fail with the reason); answers when to check in next (5 s while an administrator watches) and the team keys'' hash. Granted to anon: the token is the authority.';

-- ── The waterfall, for the tab (decisions 2 and 3) ───────────────────────────
-- {"now", "hours", "bucket_s", "from",
--  "rows":   [{"t", "key", "center_hz", "rate", "floor_db", "span_s", "n", "bins"}],
--  "bursts": [[t, freq_mhz, bursts, decoded, alert2, best_snr_db]]}
-- t is the slice's start, in seconds since 1970; a row's bins are base64.

create or replace function meganet.admin_base_station_spectrum(p_id bigint, p_hours integer default 1, p_since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := pg_catalog.now();
  v_hours  integer := greatest(1, least(48, coalesce(p_hours, 1)));
  v_bucket integer;
  v_from   timestamptz;
  v_rows   jsonb;
  v_bursts jsonb;
begin
  perform meganet.admin_require();
  if not exists (select 1 from meganet.ingest_token t where t.id = p_id) then
    raise exception 'no ingest token %', p_id using errcode = '22023';
  end if;
  -- 360 slices a window: ten seconds an hour shown.
  v_bucket := v_hours * 10;
  v_from := v_now - pg_catalog.make_interval(hours => v_hours);
  if p_since is not null and p_since > v_from then
    v_from := pg_catalog.to_timestamp((pg_catalog.floor(extract(epoch from p_since) / v_bucket) * v_bucket)::double precision);
  end if;

  with r as (
    select p.rx_key, p.center_hz, p.rate, p.floor_db, p.span_s, p.bins, pg_catalog.octet_length(p.bins) as len,
           (pg_catalog.floor(extract(epoch from p.at) / v_bucket) * v_bucket)::bigint as t
      from meganet.base_station_spectrum p
     where p.ingest_token_id = p_id and p.at >= v_from),
  g as (
    select r.rx_key, r.center_hz, r.rate, r.len, r.t,
           pg_catalog.round(pg_catalog.avg(r.floor_db)::numeric, 1) as floor_db, pg_catalog.sum(r.span_s) as span_s, pg_catalog.count(*) as n
      from r group by r.rx_key, r.center_hz, r.rate, r.len, r.t),
  m as (
    select r.rx_key, r.center_hz, r.rate, r.len, r.t, i.i, pg_catalog.max(pg_catalog.get_byte(r.bins, i.i)) as v
      from r cross join lateral pg_catalog.generate_series(0, r.len - 1) as i(i)
     group by r.rx_key, r.center_hz, r.rate, r.len, r.t, i.i),
  j as (
    select m.rx_key, m.center_hz, m.rate, m.len, m.t,
           pg_catalog.decode(pg_catalog.string_agg(pg_catalog.lpad(pg_catalog.to_hex(m.v), 2, '0'), '' order by m.i), 'hex') as bins
      from m group by m.rx_key, m.center_hz, m.rate, m.len, m.t)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           't', g.t, 'key', g.rx_key, 'center_hz', g.center_hz, 'rate', g.rate, 'floor_db', g.floor_db,
           'span_s', g.span_s, 'n', g.n, 'bins', pg_catalog.translate(pg_catalog.encode(j.bins, 'base64'), E'\n', ''))
           order by g.t, g.rx_key)
    into v_rows
    from g join j using (rx_key, center_hz, rate, len, t);

  -- What it heard, in the same slices: a burst is a moment a receiver heard
  -- something on a frequency, however many readings it carried.
  with x as (
    select (pg_catalog.floor(extract(epoch from x.heard_at) / v_bucket) * v_bucket)::bigint as t,
           pg_catalog.round((x.detail ->> 'freq_mhz')::numeric, 4) as f,
           x.heard_at, x.ok, x.protocol,
           case when pg_catalog.jsonb_typeof(x.detail -> 'snr_db') = 'number' then (x.detail ->> 'snr_db')::numeric
                when x.level_dbfs is not null and pg_catalog.jsonb_typeof(x.detail -> 'nf_dbfs') = 'number'
                  then x.level_dbfs::numeric - (x.detail ->> 'nf_dbfs')::numeric end as snr
      from meganet.reception x
     where x.ingest_token_id = p_id and x.heard_at >= v_from and x.heard_at <= v_now + interval '1 minute'
       and pg_catalog.jsonb_typeof(x.detail -> 'freq_mhz') = 'number'),
  y as (
    select x.t, x.f, pg_catalog.count(distinct x.heard_at) as n,
           pg_catalog.count(distinct x.heard_at) filter (where x.ok) as decoded,
           pg_catalog.count(distinct x.heard_at) filter (where x.ok and x.protocol = 'alert2') as alert2,
           pg_catalog.round(pg_catalog.max(x.snr), 1) as snr
      from x group by x.t, x.f
     order by x.t desc, x.f
     limit 5000)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(y.t, y.f, y.n, y.decoded, y.alert2, y.snr) order by y.t, y.f)
    into v_bursts
    from y;

  return pg_catalog.jsonb_build_object(
    'now', v_now, 'hours', v_hours, 'bucket_s', v_bucket, 'from', v_from,
    'rows', coalesce(v_rows, '[]'::jsonb), 'bursts', coalesce(v_bursts, '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station_spectrum(bigint, integer, timestamptz) is
  'A base station''s waterfall for the Base Stations tab (0068): its sticks'' spectrum rows over the last 1–48 hours, folded into at most 360 slices (each bin the strongest it was), and the receptions it sent in the same slices by frequency — bursts, decoded, ALERT2, the best signal. p_since: only the slices from then on. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.base_station_checkin(jsonb)                                    from public;
revoke all on function meganet.admin_base_station_spectrum(bigint, integer, timestamptz)      from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.base_station_checkin(jsonb)                               to anon, authenticated, service_role;
  grant execute on function meganet.admin_base_station_spectrum(bigint, integer, timestamptz) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('meganet.base_station_spectrum') is null
     or to_regprocedure('meganet.admin_base_station_spectrum(bigint, integer, timestamptz)') is null
     or (select pg_catalog.strpos(p.prosrc, 'spectra') from pg_catalog.pg_proc p
          where p.oid = 'meganet.base_station_checkin(jsonb)'::pg_catalog.regprocedure) = 0 then
    raise exception '0068 did not take: the spectrum table, its function or the check-in''s spectra are missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.base_station_spectrum'::pg_catalog.regclass) then
    raise exception '0068 did not take: meganet.base_station_spectrum has RLS off';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 68 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '68')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
