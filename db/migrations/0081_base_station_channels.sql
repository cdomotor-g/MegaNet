-- 0081_base_station_channels.sql — What a base station hears, channel by
-- channel: who is on each frequency, and what the register expects there.
-- For the Base Stations tab's Channels panel.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0081_base_station_channels.sql
--
-- Why this file exists
-- ────────────────────
-- In October 2026 18 Bateson listened on up to ten channels at once, over two
-- sticks, and what it heard on each could be worked out only by hand from
-- meganet.reception: 151.5375 MHz carried more than any other (an ALERT2 link,
-- ~50,000 receptions a day), 152.400 went silent for two days on the weaker
-- stick without anything saying so, 151.575 MHz was full of stations the
-- register does not have, and some IDs on 151.500 were the register's
-- stations in Victoria — another network's IDs, heard here. Its owner wanted
-- that worked out for them, a channel a row: what is heard, from whom, what
-- the register says should be there and what the ACMA has licensed — the lay
-- of the land before any tidying up.
--
-- Four decisions.
--
-- **1. From the rollups, not the receptions.** reception_hourly (0071) keeps
-- who was heard by which receiver, over what, an hour a row — a week of 18
-- Bateson is ~40,000 rows where reception has ~350,000, and the same question
-- of reception took 14 s on the live project (PostgREST's limit is 8), of the
-- rollup 1 s. Up to 14 days are read by the hour; longer, up to 90, by the day
-- (reception_daily). A rollup runs hourly, so the last hour or so may not be
-- in it yet; `to` says how far it reaches.
--
-- **2. A channel is a frequency and a protocol.** freq_max rounded to 0.1 kHz
-- (through double precision: a real says 151.538 for 151.5375). ALERT and
-- ALERT2 on one frequency are two rows, because they are two networks — on
-- 151.500 at 18 Bateson they were.
--
-- **3. An ID is put down to the register's nearest station.** A legacy ID is
-- a sensor's (meganet.sensor.alert_id), an ALERT2 one a station's
-- (station.alert2_station_id). Several stations can hold one ID — the register
-- spans states — so the one nearest the base station is taken, with how many
-- held it. Only IDs decoded at least three times count towards a channel's
-- tally (`ids`): one decode can be a corrupted copy that passed its checks.
-- Nearer than 400 km is this network (`near`; repeaters carry stations a few
-- hundred km); further is another network's station using the same ID (`far`);
-- no station at all is one the register does not have (`unknown`).
--
-- **4. The register's frequencies come with it.** Every repeater's own RX/TX
-- pair (meganet.repeater) and every other listed pair (station_frequency,
-- 0033), with its station and how far it is, so the panel can say what is
-- expected on each channel without the stations document. The ACMA side is
-- the panel's own, from data/acma-devices.json — the database holds no licence
-- data.
--
-- Administrators only, like everything about a base station. Depends on 0049,
-- 0071 and 0072. tools/check_base_station_channels.sql proves it.

-- ── Distance ─────────────────────────────────────────────────────────────────

create or replace function meganet.geo_km(p_lat1 double precision, p_lon1 double precision,
                                          p_lat2 double precision, p_lon2 double precision)
returns double precision
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  -- Great-circle kilometres (haversine, a sphere of 6,371 km). Strict: null
  -- when any point is — least() below would otherwise take a null for 1.
  select 2 * 6371 * pg_catalog.asin(pg_catalog.sqrt(least(1,
           pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_lat2 - p_lat1) / 2), 2)
           + pg_catalog.cos(pg_catalog.radians(p_lat1)) * pg_catalog.cos(pg_catalog.radians(p_lat2))
             * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_lon2 - p_lon1) / 2), 2))));
$$;

comment on function meganet.geo_km(double precision, double precision, double precision, double precision) is
  'Great-circle distance in km between two latitude/longitude points (haversine; 0081). Null when any argument is.';

-- ── The panel's one call ─────────────────────────────────────────────────────

create or replace function meganet.admin_base_station_channels(p_id bigint, p_days integer default 7)
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
  v_lat    double precision;
  v_lon    double precision;
  v_to     timestamptz;
  v_chans  jsonb;
  v_reg    jsonb;
  c_far    constant integer := 400;   -- km: beyond it, another network's station with the same ID
  c_min    constant integer := 3;     -- decodes before an ID counts towards a channel's tally
begin
  perform meganet.admin_require();
  if not exists (select 1 from meganet.ingest_token t where t.id = p_id) then
    raise exception 'no ingest token %', p_id using errcode = '22023';
  end if;
  v_from := v_now - pg_catalog.make_interval(days => v_days);

  -- Where it is: what it last said, else its host station.
  select coalesce(case when pg_catalog.jsonb_typeof(b.status -> 'location' -> 'lat') = 'number' then (b.status -> 'location' ->> 'lat')::double precision end,
                  h.lat::double precision),
         coalesce(case when pg_catalog.jsonb_typeof(b.status -> 'location' -> 'lon') = 'number' then (b.status -> 'location' ->> 'lon')::double precision end,
                  h.lon::double precision)
    into v_lat, v_lon
    from meganet.ingest_token t
    left join meganet.base_station b on b.ingest_token_id = t.id
    left join meganet.station h on h.id = t.host_station_id
   where t.id = p_id;

  with src as materialized (
    select pg_catalog.round(coalesce(r.freq_max, r.freq_min)::double precision::numeric, 4) as f, r.protocol, r.station as id,
           r.point_id, r.bucket, r.n, r.n_ok, r.n_undecoded, r.snr_n, r.snr_sum, r.snr_max, r.first_heard, r.last_heard
      from meganet.reception_hourly r
     where v_days <= 14 and r.ingest_token_id = p_id and r.bucket >= v_from and coalesce(r.freq_max, r.freq_min) is not null
    union all
    select pg_catalog.round(coalesce(r.freq_max, r.freq_min)::double precision::numeric, 4), r.protocol, r.station,
           r.point_id, r.bucket::timestamp at time zone 'UTC', r.n, r.n_ok, r.n_undecoded, r.snr_n, r.snr_sum, r.snr_max, r.first_heard, r.last_heard
      from meganet.reception_daily r
     where v_days > 14 and r.ingest_token_id = p_id and r.bucket >= (v_from at time zone 'UTC')::date
       and coalesce(r.freq_max, r.freq_min) is not null),
  ids as (
    select s.f, s.protocol, s.id, pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok, pg_catalog.max(s.last_heard) as last
      from src s
     where s.id is not null
     group by s.f, s.protocol, s.id
    having pg_catalog.sum(s.n_ok) > 0),
  who as (
    select i.*, m.station_id, m.name, m.owner, m.km, coalesce(m.held, 0) as held
      from ids i
      left join lateral (
        select st.id as station_id, st.name, st.owner,
               pg_catalog.round(meganet.geo_km(v_lat, v_lon, st.lat::double precision, st.lon::double precision)::numeric) as km,
               pg_catalog.count(*) over () as held
          from meganet.station st
         where st.deleted_at is null
           and ((i.protocol = 'alert' and exists (select 1 from meganet.sensor se where se.station_id = st.id and se.alert_id = i.id))
             or (i.protocol = 'alert2' and st.alert2_station_id = i.id))
         order by meganet.geo_km(v_lat, v_lon, st.lat::double precision, st.lon::double precision) nulls last, st.id
         limit 1) m on true),
  per as (
    select s.f, s.protocol, pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.sum(s.n_undecoded)::bigint as undecoded,
           pg_catalog.round((pg_catalog.sum(s.snr_sum) / nullif(pg_catalog.sum(s.snr_n), 0))::numeric, 1) as snr,
           pg_catalog.round(pg_catalog.max(s.snr_max)::numeric, 1) as snr_max,
           pg_catalog.min(s.first_heard) as first, pg_catalog.max(s.last_heard) as last,
           pg_catalog.count(distinct s.bucket) filter (where s.n_ok > 0) as buckets,
           pg_catalog.array_agg(distinct s.point_id order by s.point_id) as points
      from src s
     group by s.f, s.protocol),
  daily as (
    select d.f, d.protocol, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(d.day, d.n, d.ok) order by d.day) as days
      from (select s.f, s.protocol, (s.bucket at time zone 'UTC')::date as day, pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok
              from src s group by 1, 2, 3) d
     group by d.f, d.protocol)
  select (select pg_catalog.max(s.last_heard) from src s),
         pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'f', p.f, 'protocol', p.protocol, 'n', p.n, 'ok', p.ok, 'undecoded', p.undecoded,
           'snr', p.snr, 'snr_max', p.snr_max, 'first', p.first, 'last', p.last, 'buckets', p.buckets,
           'points', pg_catalog.to_jsonb(p.points),
           'ids', (select pg_catalog.jsonb_build_object(
                     'any', pg_catalog.count(*),
                     'counted', pg_catalog.count(*) filter (where w.ok >= c_min),
                     'near', pg_catalog.count(*) filter (where w.ok >= c_min and w.km <= c_far),
                     'far', pg_catalog.count(*) filter (where w.ok >= c_min and w.km > c_far),
                     'unknown', pg_catalog.count(*) filter (where w.ok >= c_min and w.station_id is null),
                     'near_ok', coalesce(pg_catalog.sum(w.ok) filter (where w.km <= c_far), 0),
                     'far_ok', coalesce(pg_catalog.sum(w.ok) filter (where w.km > c_far), 0),
                     'unknown_ok', coalesce(pg_catalog.sum(w.ok) filter (where w.station_id is null), 0))
                     from who w where w.f = p.f and w.protocol = p.protocol),
           -- The most decoded, then the furthest-off and the unknown ones on their own,
           -- since a busy channel's top twelve can hide them: [id, decoded, heard,
           -- last, station id, name, owner, km, stations holding the id].
           'top', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(w.id, w.ok, w.n, w.last, w.station_id, w.name, w.owner, w.km, w.held)
                                                       order by w.ok desc, w.id), '[]'::jsonb)
                     from (select * from who w where w.f = p.f and w.protocol = p.protocol order by w.ok desc, w.id limit 12) w),
           'far', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(w.id, w.ok, w.n, w.last, w.station_id, w.name, w.owner, w.km, w.held)
                                                       order by w.ok desc, w.id), '[]'::jsonb)
                     from (select * from who w where w.f = p.f and w.protocol = p.protocol and w.ok >= c_min and w.km > c_far
                            order by w.ok desc, w.id limit 8) w),
           'unknown', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(w.id, w.ok, w.n, w.last) order by w.ok desc, w.id), '[]'::jsonb)
                     from (select * from who w where w.f = p.f and w.protocol = p.protocol and w.ok >= c_min and w.station_id is null
                            order by w.ok desc, w.id limit 8) w),
           'days', coalesce(d.days, '[]'::jsonb))
           order by p.f, p.protocol)
    into v_to, v_chans
    from per p left join daily d on d.f = p.f and d.protocol = p.protocol;

  -- What the register says is on each frequency: a repeater's own pair and
  -- every other pair listed, with its station and how far it is from here.
  with pairs as (
    select r.station_id, 'repeater' as kind, null::text as label, nullif(r.acma_licence, '') as licence, r.rx_mhz, r.tx_mhz
      from meganet.repeater r
    union all
    select f.station_id, 'listed', nullif(f.label, ''), nullif(f.acma_licence, ''), f.rx_mhz, f.tx_mhz
      from meganet.station_frequency f),
  dirs as (
    select p.station_id, p.kind, p.label, p.licence, 'tx' as dir, pg_catalog.round(p.tx_mhz, 4) as f from pairs p where p.tx_mhz is not null
    union
    select p.station_id, p.kind, p.label, p.licence, 'rx', pg_catalog.round(p.rx_mhz, 4) from pairs p where p.rx_mhz is not null)
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'f', x.f, 'dir', x.dir, 'kind', x.kind, 'station_id', x.station_id, 'name', st.name, 'owner', st.owner,
           'label', x.label, 'licence', x.licence,
           'km', pg_catalog.round(meganet.geo_km(v_lat, v_lon, st.lat::double precision, st.lon::double precision)::numeric))
           order by x.f, meganet.geo_km(v_lat, v_lon, st.lat::double precision, st.lon::double precision) nulls last, x.station_id, x.dir), '[]'::jsonb)
    into v_reg
    from dirs x
    join meganet.station st on st.id = x.station_id and st.deleted_at is null;

  return pg_catalog.jsonb_build_object(
    'now', v_now, 'days', v_days, 'from', v_from, 'to', v_to, 'by', case when v_days <= 14 then 'hour' else 'day' end,
    'far_km', c_far, 'min_decodes', c_min,
    'site', case when v_lat is null or v_lon is null then null else pg_catalog.jsonb_build_object('lat', v_lat, 'lon', v_lon) end,
    'channels', coalesce(v_chans, '[]'::jsonb), 'register', v_reg);
end;
$$;

comment on function meganet.admin_base_station_channels(bigint, integer) is
  'A base station''s channels over the last p_days (1–90, default 7) for the Base Stations tab (0081): per frequency and protocol, from the reception rollups, what it heard and decoded, its signal, the hours or days it was heard in, and its IDs put down to the register''s nearest station — near (within 400 km), far (another network''s station with the ID) or unknown — and the register''s frequencies with how far each station is. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.geo_km(double precision, double precision, double precision, double precision) from public;
revoke all on function meganet.admin_base_station_channels(bigint, integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- authenticated, not anon: admin_require() asks as well, but an anonymous
  -- caller has no business reaching the question.
  grant execute on function meganet.admin_base_station_channels(bigint, integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('meganet.geo_km(double precision, double precision, double precision, double precision)') is null
     or to_regprocedure('meganet.admin_base_station_channels(bigint, integer)') is null then
    raise exception '0081 did not take: geo_km() or admin_base_station_channels() is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 81 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '81')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
