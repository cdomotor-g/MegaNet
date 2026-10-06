-- 0051_site_surveys.sql — A receiver left at a candidate site for a few days:
-- what it heard there, beside what the network itself received.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0051_site_surveys.sql
--
-- Why this file exists
-- ────────────────────
-- Whether a hill is worth a repeater, or a depot a base station, is a question
-- a receiver answers by being there. RPi ALERT 0.9 does that as a site survey
-- (its docs/survey.md): a Pi left at the site for a day or three, often with
-- no network, which keeps every frame it hears and sends them, when it is next
-- on a network, as receptions (0047) with { "survey": id, "survey_name": … }
-- in their detail. Receptions take any age (back to 1990) and are never pruned,
-- carry their own position and signal, and touch nothing else — unlike a
-- reading posted days late, which would mark its station seen now (0012's
-- station_status) and sit beside the network's own copy of it, since readings
-- deduplicate on the exact moment (0006) and no two receivers time a burst
-- the same. So a survey's evidence is its receptions; its readings stay on the
-- Pi unless it is asked to send them.
--
-- What the Reception Map could not do with them: reception_window() looks
-- back from now and holds the newest 20,000 rows of every receiver together,
-- so a busy week pushes a survey out and its receiver cannot be picked. And
-- nothing said how much of what was sent the site heard.
--
-- What changes
-- ────────────
--   1. An index on the survey tag, for the rows that have one.
--   2. survey_list()          every survey: its name, the token it came by,
--                             when, where, how much it heard.
--   3. survey_receptions(id)  one survey's receptions, in reception_window()'s
--                             shape, for the map and the bad-copy analysis.
--   4. survey_summary(id)     each address: what the site heard (good and bad
--                             frames, signal and SNR percentiles), and what the
--                             network stored from it over the same days — its
--                             transmissions, how many of those the site heard,
--                             and how many the site heard that the network did
--                             not. Done here rather than in the browser because
--                             it is a join of every survey frame against the
--                             readings of the same days.
--
-- How "heard of sent" is counted
-- ──────────────────────────────
--   * A transmission is one value from one address: copies of the same address
--     and value within 5 s are one (a burst heard by two base stations, or a
--     station that sends each report twice).
--   * What the network sent is meganet.reading over the survey's first to last
--     frame — ALERT and ALERT2 readings, what goes over the air — less readings
--     only the survey itself stored (a survey told to send its readings too), counted only while the survey was listening — some
--     frame of its, any address, within 20 minutes either side — so a night
--     with the Pi switched off is not held against the site.
--   * Heard: a good survey frame of the same address and value within
--     p_match_s (10 s) of the network's reading. A survey timed by GPS or NTP
--     is within a second or two; the window allows a battery RTC's drift.
--   * Only here: a good survey transmission no reading of the network matches.
--     The site heard a station the network did not — the case for building.
--
-- Who can read it: editors, like the receptions themselves (0047) — a
-- receiver's frames are a record of where it was.

-- ── 1. The index ─────────────────────────────────────────────────────────────

create index if not exists reception_survey_idx
  on meganet.reception ((detail ->> 'survey'), heard_at)
  where detail ? 'survey';

-- ── 2. Every survey ──────────────────────────────────────────────────────────

create or replace function meganet.survey_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_editor() then
    raise exception 'site surveys are for editors' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) order by q.last_heard desc)
      from (select x.detail ->> 'survey' as id,
                   pg_catalog.max(x.detail ->> 'survey_name') as name,
                   pg_catalog.max(t.label) as token_label,
                   pg_catalog.min(x.heard_at) as first_heard,
                   pg_catalog.max(x.heard_at) as last_heard,
                   pg_catalog.count(*) as frames,
                   pg_catalog.count(*) filter (where x.ok) as ok,
                   pg_catalog.count(*) filter (where not x.ok and x.alert_id is not null) as bad,
                   pg_catalog.count(*) filter (where x.alert_id is null) as undecoded,
                   pg_catalog.count(distinct x.alert_id) filter (where x.ok) as addresses,
                   pg_catalog.avg(x.lat) as lat,
                   pg_catalog.avg(x.lon) as lon,
                   coalesce(pg_catalog.bool_or(x.location_source = 'gps'), false) as gps,
                   pg_catalog.array_agg(distinct x.point_id) as points
              from meganet.reception x
              join meganet.ingest_token t on t.id = x.ingest_token_id
             where x.detail ? 'survey'
             group by x.detail ->> 'survey') q
  ), '[]'::jsonb);
end;
$$;

comment on function meganet.survey_list() is
  'Every site survey (receptions tagged detail.survey, RPi ALERT 0.9): name, token label, first and last frame, frames good/bad/undecoded, addresses heard, mean position, receivers. Editors only (0051).';

-- ── 3. One survey's receptions ───────────────────────────────────────────────

create or replace function meganet.survey_receptions(p_survey text, p_limit integer default 50000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_editor() then
    raise exception 'site surveys are for editors' using errcode = '42501';
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
      from (select * from meganet.reception r
             where r.detail ? 'survey' and r.detail ->> 'survey' = p_survey
             order by r.heard_at
             limit greatest(1, least(coalesce(p_limit, 50000), 100000))) x
      join meganet.ingest_token t on t.id = x.ingest_token_id
      left join meganet.ingest_point_latest p on p.ingest_token_id = x.ingest_token_id and p.point_id = x.point_id
  ), '[]'::jsonb);
end;
$$;

comment on function meganet.survey_receptions(text, integer) is
  'One site survey''s receptions, oldest first, in reception_window()''s shape (at most 100,000) — for the Reception Map. Editors only (0051).';

-- ── 4. What the site heard, beside what was sent ────────────────────────────

create or replace function meganet.survey_summary(p_survey text, p_match_s integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w     interval;
  v_t0    timestamptz;
  v_t1    timestamptz;
  v_paths text[];
  v_head  jsonb;
  v_rows  jsonb;
  v_slots integer;
  v_radio smallint[];
begin
  if not meganet.is_editor() then
    raise exception 'site surveys are for editors' using errcode = '42501';
  end if;
  v_w := pg_catalog.make_interval(secs => greatest(1, least(coalesce(p_match_s, 10), 300)));
  v_radio := array(select p.code from meganet.protocol p where p.key in ('alert', 'alert2'));

  select pg_catalog.min(x.heard_at), pg_catalog.max(x.heard_at),
         pg_catalog.array_agg(distinct 'serial-monitor/' || x.point_id)
    into v_t0, v_t1, v_paths
    from meganet.reception x
   where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey;
  if v_t0 is null then
    return null;
  end if;

  -- Twenty-minute slots with anything heard: how long it was listening.
  select pg_catalog.count(distinct pg_catalog.date_bin(interval '20 minutes', x.heard_at, v_t0))
    into v_slots
    from meganet.reception x
   where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey;

  select pg_catalog.jsonb_build_object(
           'id', p_survey,
           'name', pg_catalog.max(x.detail ->> 'survey_name'),
           'token_label', pg_catalog.max(t.label),
           'first_heard', v_t0, 'last_heard', v_t1,
           'listening_h', pg_catalog.round(v_slots / 3.0, 1),
           'match_s', pg_catalog.date_part('epoch', v_w)::integer,
           'frames', pg_catalog.count(*),
           'ok', pg_catalog.count(*) filter (where x.ok),
           'bad', pg_catalog.count(*) filter (where not x.ok and x.alert_id is not null),
           'undecoded', pg_catalog.count(*) filter (where x.alert_id is null),
           'lat', pg_catalog.avg(x.lat), 'lon', pg_catalog.avg(x.lon),
           'gps', coalesce(pg_catalog.bool_or(x.location_source = 'gps'), false),
           'location_source', pg_catalog.max(x.location_source),
           'points', (select pg_catalog.jsonb_agg(pp order by pp.point_id) from (
                        select y.point_id, y.receiver,
                               pg_catalog.max(case when pg_catalog.jsonb_typeof(y.detail -> 'freq_mhz') = 'number' then (y.detail ->> 'freq_mhz')::numeric end) as freq_mhz,
                               pg_catalog.count(*) filter (where y.ok) as ok,
                               pg_catalog.count(*) filter (where not y.ok and y.alert_id is not null) as bad,
                               pg_catalog.count(*) filter (where y.alert_id is null) as undecoded
                          from meganet.reception y
                         where y.detail ? 'survey' and y.detail ->> 'survey' = p_survey
                         group by y.point_id, y.receiver) pp))
    into v_head
    from meganet.reception x
    join meganet.ingest_token t on t.id = x.ingest_token_id
   where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey;

  with sv as (
    select x.alert_id, x.value_raw, x.heard_at, x.ok, x.point_id, x.rssi_dbm, x.level_dbfs,
           case when pg_catalog.jsonb_typeof(x.detail -> 'snr_db') = 'number' then (x.detail ->> 'snr_db')::real
                when x.rssi_dbm is not null and x.nf_dbm is not null then x.rssi_dbm - x.nf_dbm end as snr_db,
           case when pg_catalog.jsonb_typeof(x.detail -> 'freq_mhz') = 'number' then (x.detail ->> 'freq_mhz')::numeric end as freq_mhz
      from meganet.reception x
     where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey and x.alert_id is not null
  ),
  heard as (
    select s.alert_id,
           pg_catalog.count(*) filter (where s.ok) as ok,
           pg_catalog.count(*) filter (where not s.ok) as bad,
           pg_catalog.min(s.heard_at) filter (where s.ok) as first_heard,
           pg_catalog.max(s.heard_at) filter (where s.ok) as last_heard,
           pg_catalog.percentile_disc(array[0.1, 0.5, 0.9]) within group (order by s.level_dbfs) filter (where s.ok and s.level_dbfs is not null) as level_dbfs,
           pg_catalog.percentile_disc(array[0.1, 0.5, 0.9]) within group (order by s.rssi_dbm) filter (where s.ok and s.rssi_dbm is not null) as rssi_dbm,
           pg_catalog.percentile_disc(0.5) within group (order by s.snr_db) filter (where s.ok and s.snr_db is not null) as snr_db,
           pg_catalog.array_agg(distinct s.freq_mhz) filter (where s.freq_mhz is not null) as freqs,
           pg_catalog.array_agg(distinct s.point_id) as points
      from sv s
     group by s.alert_id
  ),
  -- The site's good frames as transmissions: one per address and value within 5 s.
  svt as (
    select q.alert_id, q.value_raw, q.heard_at
      from (select s.alert_id, s.value_raw, s.heard_at,
                   pg_catalog.lag(s.heard_at) over (partition by s.alert_id, s.value_raw order by s.heard_at) as prev
              from sv s
             where s.ok and s.value_raw is not null) q
     where q.prev is null or q.heard_at - q.prev > interval '5 seconds'
  ),
  only_here as (
    select t.alert_id, pg_catalog.count(*) as n
      from svt t
     where not exists (
             select 1 from meganet.reading r
              where r.addr = 'a:' || t.alert_id
                and r.reading_ts between t.heard_at - v_w and t.heard_at + v_w
                and r.value_raw = t.value_raw
                and not (coalesce(r.path, '') = any (v_paths)
                         and not exists (select 1 from pg_catalog.unnest(r.dup_paths) d where d <> all (v_paths))))
     group by t.alert_id
  ),
  -- What the network stored over the same days, less what only the survey stored.
  net as (
    select q.alert_id, q.value_raw, q.reading_ts
      from (select r.alert_id, r.value_raw, r.reading_ts,
                   pg_catalog.lag(r.reading_ts) over (partition by r.alert_id, r.value_raw order by r.reading_ts) as prev
              from meganet.reading r
             where r.reading_ts between v_t0 and v_t1
               and r.alert_id is not null
               and r.protocol = any (v_radio)
               and not (coalesce(r.path, '') = any (v_paths)
                        and not exists (select 1 from pg_catalog.unnest(r.dup_paths) d where d <> all (v_paths)))) q
     where q.prev is null or q.reading_ts - q.prev > interval '5 seconds'
  ),
  sent as (
    select n.alert_id,
           pg_catalog.count(*) as sent,
           pg_catalog.count(*) filter (where exists (
             select 1 from meganet.reception s
              where s.alert_id = n.alert_id and s.heard_at between n.reading_ts - v_w and n.reading_ts + v_w
                and s.value_raw = n.value_raw and s.ok
                and s.detail ? 'survey' and s.detail ->> 'survey' = p_survey)) as heard_of_sent
      from net n
     where exists (select 1 from meganet.reception s
                    where s.detail ? 'survey' and s.detail ->> 'survey' = p_survey
                      and s.heard_at between n.reading_ts - interval '20 minutes' and n.reading_ts + interval '20 minutes')
     group by n.alert_id
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'alert_id', coalesce(h.alert_id, n.alert_id),
           'ok', coalesce(h.ok, 0), 'bad', coalesce(h.bad, 0),
           'first_heard', h.first_heard, 'last_heard', h.last_heard,
           'level_dbfs', h.level_dbfs, 'rssi_dbm', h.rssi_dbm, 'snr_db', h.snr_db,
           'freqs', h.freqs, 'points', h.points,
           'sent', coalesce(n.sent, 0), 'heard_of_sent', coalesce(n.heard_of_sent, 0),
           'only_here', coalesce(o.n, 0))
           order by coalesce(h.ok, 0) desc, coalesce(h.alert_id, n.alert_id))
    into v_rows
    from heard h
    full join sent n on n.alert_id = h.alert_id
    left join only_here o on o.alert_id = coalesce(h.alert_id, n.alert_id);

  return v_head || pg_catalog.jsonb_build_object('stations', coalesce(v_rows, '[]'::jsonb));
end;
$$;

comment on function meganet.survey_summary(text, integer) is
  'One site survey, address by address: good/bad frames, level (dBFS) and RSSI (dBm) p10/p50/p90, median SNR, channels; and from meganet.reading over the same days, the transmissions sent while it listened, how many it heard (same address and value within p_match_s), and how many it heard that the network did not. Editors only (0051).';

revoke all on function meganet.survey_list() from public;
revoke all on function meganet.survey_receptions(text, integer) from public;
revoke all on function meganet.survey_summary(text, integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.survey_list() to authenticated, service_role;
  grant execute on function meganet.survey_receptions(text, integer) to authenticated, service_role;
  grant execute on function meganet.survey_summary(text, integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

do $$
begin
  if to_regprocedure('meganet.survey_list()') is null
     or to_regprocedure('meganet.survey_receptions(text, integer)') is null
     or to_regprocedure('meganet.survey_summary(text, integer)') is null
     or to_regclass('meganet.reception_survey_idx') is null then
    raise exception '0051 did not take';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and pg_catalog.has_function_privilege('anon', 'meganet.survey_summary(text, integer)', 'execute') then
    raise exception '0051 did not take: anon can execute meganet.survey_summary()';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 50 → 51 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '51')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
