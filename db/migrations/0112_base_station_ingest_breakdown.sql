-- 0112_base_station_ingest_breakdown.sql — What comes in through each base
-- station, station by station.
--
-- Why this file exists
-- ────────────────────
-- 0111's admin_base_station_ingest() answers "how much, of which protocol" per
-- base station. The Base Stations tab now also answers "whose": the same
-- messages by station owner, radio network, kind of station, catchment and
-- council area, and — for ALERT2 — by the repeaters they came through. Owners
-- mostly live in the Bureau's Service Level Specification, which the browser
-- holds and the database does not, so the grouping is the tab's: this function
-- hands it each counted station by name and the tab looks the rest up in the
-- register it already has, where a new way to group needs no migration.
--
-- What changes — the function restated from 0111, with three additions:
--
--   `ids`    per base station, each station it decoded three times or more:
--            [protocol, id, decoded, the register's station id or null, the
--            legacy sensor's type or null, only here]. What it decoded fewer
--            than three times, or could not put an ID to, is the difference
--            between these and the protocol's total.
--   `paths`  per base station, its ALERT2 messages by repeater path (an empty
--            path is straight from the station), each address named where the
--            register has it.
--   `days`   each day gains, after the four numbers 0111 gave: legacy heard,
--            ALERT2 heard, legacy IDs decoded that day, ALERT2 stations
--            decoded that day — what the tab's bars say on hover.
--
-- Nothing is taken away, so a tab built for 0111 reads 0112 unchanged. Still
-- the rollups only (hourly to 14 days, daily beyond), never `reception`;
-- still administrators only. tools/check_base_station_steady.sql proves it.
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
begin
  perform meganet.admin_require();
  v_from := v_now - pg_catalog.make_interval(days => v_days);

  with src as materialized (
    select r.ingest_token_id as tok, r.point_id, coalesce(r.protocol, 'alert') as protocol, r.station as id, r.path,
           (r.bucket at time zone 'UTC')::date as day, r.n, r.n_ok, r.n_undecoded, r.n_dup, r.n_bad, r.last_heard
      from meganet.reception_hourly r
     where v_days <= 14 and r.bucket >= v_from and r.survey is null
    union all
    select r.ingest_token_id, r.point_id, coalesce(r.protocol, 'alert'), r.station, r.path,
           r.bucket, r.n, r.n_ok, r.n_undecoded, r.n_dup, r.n_bad, r.last_heard
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
           'ids', coalesce(i.j, '[]'::jsonb), 'paths', coalesce(w.j, '[]'::jsonb))
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
  'What comes in through each base station over the last p_days (1–90, default 7) for the Base Stations tab (0111, 0112): per ingest token and protocol, from the reception rollups (hourly up to 14 days, daily beyond; drive surveys left out), messages heard, decoded, undecoded, duplicate and bad, the stations decoded three times or more, how many of them the register has and how many no other base station decoded; the same per receiver; each counted station with the register''s station and sensor type (ids); ALERT2 messages by repeater path (paths); decoded and heard messages and stations a UTC day; and the stations decoded by the network as a whole. Administrators only.';

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
    raise exception '0112 did not take: the function is missing';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.admin_base_station_ingest(integer)', 'execute') then
    raise exception '0112 did not take: public may run the function';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 112 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '112')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
