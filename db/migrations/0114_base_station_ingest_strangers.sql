-- 0114_base_station_ingest_strangers.sql — The stations a base station decodes
-- that the register does not hold, each with what might say whose it is.
--
-- Why this file exists
-- ────────────────────
-- 0112's breakdown put a number on it: at one base station nearly all the
-- ALERT2 it decodes comes from addresses the register does not hold. The next
-- question is whose they are — which agency to ring. Nothing on the air names
-- an owner, so the Base Stations tab lays out what narrows it down, and this
-- function hands it over, still from the reception rollups alone:
--
--   `strangers`  per base station, each station it decoded three times or more
--                that the register does not hold: protocol, id, decoded and
--                heard, first and last heard in the period, the days it was
--                decoded on, the first day the daily rollup has it at all
--                (`since`), its mean SNR, the frequency it was measured on
--                (fmin, fmax, MHz), the same per receiver (`points`:
--                [receiver, decoded, fmin, fmax, SNR]) and, for ALERT2, its
--                busiest eight repeater paths (`paths`: [path, decoded, SNR]).
--                A path's last address is the transmitter the base station
--                itself heard, which is why SNR goes with it.
--   `site`       where the base station is (what it last said, else its host
--                station, as 0081), so the tab can set the ACMA's licences on
--                a frequency against it.
--
-- Nothing is taken away. Administrators only. Depends on 0112.
-- tools/check_base_station_steady.sql proves it.
--
-- Idempotent and forward-only, per db/README.md.

create or replace function meganet.admin_base_station_ingest(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := pg_catalog.now();
  v_days   integer := greatest(1, least(90, coalesce(p_days, 7)));
  v_from   timestamptz;
  v_to     timestamptz;
  v_out    jsonb;
  v_net    jsonb;
  c_min    constant integer := 3;   -- decodes before a station counts, as 0081
  c_paths  constant integer := 8;   -- a stranger's paths, the busiest
begin
  perform meganet.admin_require();
  v_from := v_now - pg_catalog.make_interval(days => v_days);

  with src as materialized (
    select r.ingest_token_id as tok, r.point_id, coalesce(r.protocol, 'alert') as protocol, r.station as id, r.path,
           (r.bucket at time zone 'UTC')::date as day, r.n, r.n_ok, r.n_undecoded, r.n_dup, r.n_bad, r.last_heard,
           r.first_heard, r.snr_sum, r.snr_n, r.freq_min, r.freq_max
      from meganet.reception_hourly r
     where v_days <= 14 and r.bucket >= v_from and r.survey is null
    union all
    select r.ingest_token_id, r.point_id, coalesce(r.protocol, 'alert'), r.station, r.path,
           r.bucket, r.n, r.n_ok, r.n_undecoded, r.n_dup, r.n_bad, r.last_heard,
           r.first_heard, r.snr_sum, r.snr_n, r.freq_min, r.freq_max
      from meganet.reception_daily r
     where v_days > 14 and r.bucket >= (v_from at time zone 'UTC')::date and r.survey is null),
  -- A station a base station decoded: the ID, and how often.
  ids as (
    select s.tok, s.protocol, s.id, pg_catalog.sum(s.n_ok)::bigint as ok
      from src s where s.id is not null
     group by s.tok, s.protocol, s.id
    having pg_catalog.sum(s.n_ok) > 0),
  counted as (
    select i.tok, i.protocol, i.id, i.ok,
           case when i.protocol = 'alert2'
                then (select st.id from meganet.station st where st.alert2_station_id = i.id and st.deleted_at is null order by st.id limit 1)
                else (select se.station_id from meganet.sensor se where se.alert_id = i.id order by se.station_id, se.ord limit 1) end as station_id,
           case when i.protocol = 'alert2' then null
                else (select se.type from meganet.sensor se where se.alert_id = i.id order by se.station_id, se.ord limit 1) end as sensor_type,
           case when i.protocol = 'alert2'
                then exists (select 1 from meganet.station st where st.alert2_station_id = i.id and st.deleted_at is null)
                else exists (select 1 from meganet.sensor se where se.alert_id = i.id) end as known,
           not exists (select 1 from ids o where o.protocol = i.protocol and o.id = i.id and o.tok <> i.tok) as only_here
      from ids i where i.ok >= c_min),
  proto as (
    select s.tok, s.protocol,
           pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.sum(s.n_undecoded)::bigint as undecoded, pg_catalog.sum(s.n_dup)::bigint as dup,
           pg_catalog.sum(s.n_bad)::bigint as bad, pg_catalog.max(s.last_heard) as last
      from src s group by s.tok, s.protocol),
  proto_j as (
    select p.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'protocol', p.protocol, 'n', p.n, 'ok', p.ok, 'undecoded', p.undecoded, 'dup', p.dup, 'bad', p.bad, 'last', p.last,
             'ids', (select pg_catalog.count(*) from counted c where c.tok = p.tok and c.protocol = p.protocol),
             'known', (select pg_catalog.count(*) from counted c where c.tok = p.tok and c.protocol = p.protocol and c.known),
             'only_here', (select pg_catalog.count(*) from counted c where c.tok = p.tok and c.protocol = p.protocol and c.only_here))
             order by p.protocol) as j
      from proto p group by p.tok),
  -- 0112: each station counted, by name: [protocol, id, decoded, the register's
  -- station, its sensor type (legacy), only here]. The tab groups them.
  ids_j as (
    select c.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
             c.protocol, c.id, c.ok, c.station_id, c.sensor_type, c.only_here) order by c.protocol, c.ok desc, c.id) as j
      from counted c group by c.tok),
  -- 0112: the way each ALERT2 message came: its repeater path, named where the
  -- register knows the address.
  path as (
    select s.tok, s.protocol, coalesce(s.path, '{}'::integer[]) as path, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.count(distinct s.id) filter (where s.n_ok > 0) as ids
      from src s where s.protocol = 'alert2'
     group by s.tok, s.protocol, coalesce(s.path, '{}'::integer[])
    having pg_catalog.sum(s.n_ok) > 0),
  path_j as (
    select p.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'protocol', p.protocol, 'path', pg_catalog.to_jsonb(p.path), 'ok', p.ok, 'ids', p.ids,
             'names', (select coalesce(pg_catalog.jsonb_agg(
                         (select st.name from meganet.station st where st.alert2_station_id = e.a and st.deleted_at is null order by st.id limit 1)
                         order by e.i), '[]'::jsonb)
                         from pg_catalog.unnest(p.path) with ordinality as e(a, i)))
             order by p.ok desc, p.path) as j
      from path p group by p.tok),
  -- 0114: the stations the register does not hold, each with what might say
  -- whose it is. Summed once by receiver and path, then read per station.
  sdet as (
    select s.tok, s.protocol, s.id, s.point_id, coalesce(s.path, '{}'::integer[]) as path,
           pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.sum(s.snr_sum) as snr_sum, pg_catalog.sum(s.snr_n)::bigint as snr_n,
           pg_catalog.min(s.freq_min) as fmin, pg_catalog.max(s.freq_max) as fmax,
           pg_catalog.min(s.first_heard) as first, pg_catalog.max(s.last_heard) as last
      from src s
     where exists (select 1 from counted c where c.tok = s.tok and c.protocol = s.protocol and c.id = s.id and not c.known)
     group by s.tok, s.protocol, s.id, s.point_id, coalesce(s.path, '{}'::integer[])),
  strangers_j as (
    select c.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'protocol', c.protocol, 'id', c.id, 'ok', c.ok, 'only_here', c.only_here,
             'n', a.n, 'first', a.first, 'last', a.last, 'snr', a.snr, 'fmin', a.fmin, 'fmax', a.fmax,
             'days', (select pg_catalog.count(distinct s.day) from src s
                       where s.tok = c.tok and s.protocol = c.protocol and s.id = c.id and s.n_ok > 0),
             -- The first day the daily rollup has it at this base station, however long ago.
             'since', (select pg_catalog.min(d.bucket) from meganet.reception_daily d
                        where d.station = c.id and d.ingest_token_id = c.tok and coalesce(d.protocol, 'alert') = c.protocol
                          and d.survey is null and d.n_ok > 0),
             'points', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(q.point_id, q.ok, q.fmin, q.fmax, q.snr) order by q.ok desc, q.point_id)
                          from (select d.point_id, pg_catalog.sum(d.ok)::bigint as ok, pg_catalog.min(d.fmin) as fmin, pg_catalog.max(d.fmax) as fmax,
                                       pg_catalog.round((pg_catalog.sum(d.snr_sum) / nullif(pg_catalog.sum(d.snr_n), 0))::numeric, 1) as snr
                                  from sdet d where d.tok = c.tok and d.protocol = c.protocol and d.id = c.id
                                 group by d.point_id having pg_catalog.sum(d.ok) > 0) q),
             'paths', case when c.protocol = 'alert2' then
                        (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(q.path), q.ok, q.snr) order by q.ok desc, q.path)
                           from (select d.path, pg_catalog.sum(d.ok)::bigint as ok,
                                        pg_catalog.round((pg_catalog.sum(d.snr_sum) / nullif(pg_catalog.sum(d.snr_n), 0))::numeric, 1) as snr
                                   from sdet d where d.tok = c.tok and d.protocol = c.protocol and d.id = c.id
                                  group by d.path having pg_catalog.sum(d.ok) > 0
                                  order by pg_catalog.sum(d.ok) desc, d.path limit c_paths) q) end)
             order by c.ok desc, c.protocol, c.id) as j
      from counted c
      cross join lateral (
        select pg_catalog.sum(d.n)::bigint as n, pg_catalog.min(d.first) as first, pg_catalog.max(d.last) as last,
               pg_catalog.min(d.fmin) as fmin, pg_catalog.max(d.fmax) as fmax,
               pg_catalog.round((pg_catalog.sum(d.snr_sum) / nullif(pg_catalog.sum(d.snr_n), 0))::numeric, 1) as snr
          from sdet d where d.tok = c.tok and d.protocol = c.protocol and d.id = c.id) a
     where not c.known
     group by c.tok),
  rx as (
    select s.tok, s.point_id, s.protocol, pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.count(distinct s.id) filter (where s.n_ok > 0) as ids, pg_catalog.max(s.last_heard) as last
      from src s group by s.tok, s.point_id, s.protocol),
  rx_j as (
    select x.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'point_id', x.point_id, 'protocol', x.protocol, 'n', x.n, 'ok', x.ok, 'ids', x.ids, 'last', x.last,
             'name', (select q.name from meganet.ingest_point_report q
                       where q.ingest_token_id = x.tok and q.point_id = x.point_id order by q.reported_at desc limit 1))
             order by x.point_id, x.protocol) as j
      from rx x group by x.tok),
  day as (
    select s.tok, s.day,
           pg_catalog.sum(s.n_ok) filter (where s.protocol = 'alert')::bigint as alert,
           pg_catalog.sum(s.n_ok) filter (where s.protocol = 'alert2')::bigint as alert2,
           pg_catalog.sum(s.n)::bigint as n,
           pg_catalog.sum(s.n) filter (where s.protocol = 'alert')::bigint as alert_n,
           pg_catalog.sum(s.n) filter (where s.protocol = 'alert2')::bigint as alert2_n,
           pg_catalog.count(distinct s.id) filter (where s.protocol = 'alert' and s.n_ok > 0) as alert_ids,
           pg_catalog.count(distinct s.id) filter (where s.protocol = 'alert2' and s.n_ok > 0) as alert2_ids
      from src s group by s.tok, s.day),
  day_j as (
    select d.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(d.day, coalesce(d.alert, 0), coalesce(d.alert2, 0), d.n,
             coalesce(d.alert_n, 0), coalesce(d.alert2_n, 0), d.alert_ids, d.alert2_ids) order by d.day) as j
      from day d group by d.tok)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', t.id, 'label', t.label, 'revoked', t.revoked_at is not null,
           'host_station', (select h.name from meganet.station h where h.id = t.host_station_id),
           'protocols', coalesce(p.j, '[]'::jsonb), 'receivers', coalesce(x.j, '[]'::jsonb), 'days', coalesce(d.j, '[]'::jsonb),
           'ids', coalesce(i.j, '[]'::jsonb), 'paths', coalesce(w.j, '[]'::jsonb),
           'strangers', coalesce(g.j, '[]'::jsonb),
           -- Where it is, as 0081: what it last said, else its host station.
           'site', (select case when z.lat is null or z.lon is null then null else pg_catalog.jsonb_build_object('lat', z.lat, 'lon', z.lon) end
                      from (select coalesce(case when pg_catalog.jsonb_typeof(b.status -> 'location' -> 'lat') = 'number' then (b.status -> 'location' ->> 'lat')::double precision end,
                                            (select h.lat::double precision from meganet.station h where h.id = t.host_station_id)) as lat,
                                   coalesce(case when pg_catalog.jsonb_typeof(b.status -> 'location' -> 'lon') = 'number' then (b.status -> 'location' ->> 'lon')::double precision end,
                                            (select h.lon::double precision from meganet.station h where h.id = t.host_station_id)) as lon
                              from (select 1) one left join meganet.base_station b on b.ingest_token_id = t.id) z))
           order by t.label, t.id),
         (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('protocol', w.protocol, 'ids', w.ids, 'known', w.known) order by w.protocol)
            from (select c.protocol, pg_catalog.count(distinct c.id) as ids, pg_catalog.count(distinct c.id) filter (where c.known) as known
                    from counted c group by c.protocol) w)
    into v_out, v_net
    from meganet.ingest_token t
    left join proto_j p on p.tok = t.id
    left join rx_j x on x.tok = t.id
    left join day_j d on d.tok = t.id
    left join ids_j i on i.tok = t.id
    left join path_j w on w.tok = t.id
    left join strangers_j g on g.tok = t.id
   where p.tok is not null or exists (select 1 from meganet.base_station b where b.ingest_token_id = t.id);

  if v_days <= 14 then
    select pg_catalog.max(r.bucket) + interval '1 hour' into v_to from meganet.reception_hourly r where r.bucket >= v_from;
  else
    select (pg_catalog.max(r.bucket) + 1)::timestamp at time zone 'UTC' into v_to
      from meganet.reception_daily r where r.bucket >= (v_from at time zone 'UTC')::date;
  end if;

  return pg_catalog.jsonb_build_object(
    'now', v_now, 'days', v_days, 'from', v_from, 'to', v_to, 'min_decodes', c_min,
    'stations', coalesce(v_out, '[]'::jsonb), 'network', coalesce(v_net, '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station_ingest(integer) is
  'What comes in through each base station over the last p_days (1–90, default 7) for the Base Stations tab (0111, 0112, 0114): per ingest token and protocol, from the reception rollups (hourly up to 14 days, daily beyond; drive surveys left out), messages heard, decoded, undecoded, duplicate and bad, the stations decoded three times or more, how many of them the register has and how many no other base station decoded; the same per receiver; each counted station with the register''s station and sensor type (ids); ALERT2 messages by repeater path (paths); each counted station the register does not hold with its frequency, receivers, paths, SNR and when it was heard (strangers); where the base station is (site); decoded and heard messages and stations a UTC day; and the stations decoded by the network as a whole. Administrators only.';

revoke all on function meganet.admin_base_station_ingest(integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.admin_base_station_ingest(integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regprocedure('meganet.admin_base_station_ingest(integer)') is null then
    raise exception '0114 did not take: the function is missing';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.admin_base_station_ingest(integer)', 'execute') then
    raise exception '0114 did not take: public may run the function';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 114 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '114')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
