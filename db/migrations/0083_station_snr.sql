-- 0083_station_snr.sql — Each transmitter's signal over the noise, measured
-- only where its own carrier says it sent the burst, and followed for months:
-- a station whose antenna, cable or connectors are going shows here before it
-- goes quiet.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0083_station_snr.sql
--
-- After 0082: it refuses to go in before it (below).
--
-- Why this file exists
-- ────────────────────
-- Every burst a base station's SDR decodes comes with its SNR (`snr_db`, 0072),
-- and the network has used it only in passing: the Reception Map shows it a
-- copy at a time, the Base Stations tab a channel's mean, and the morning
-- bulletin compares each station's median at each stick over a day with the
-- days before (tools/bulletin/gather.mjs, signalFade()). None of them can say
-- whose signal it was. A legacy burst relayed by a repeater arrives at the
-- repeater's strength, so a station heard both ways takes on its repeater's
-- SNR whenever the relay is the copy kept, and a repeater's fading antenna
-- shows on every station behind it. The owner asked (2026-10-26) for the SNR of
-- a station *where we know the signal is coming from the station directly
-- because of the carrier*, followed over time for antenna degradation, beside
-- the carrier drift on the station's card and in the station editor, with the
-- ones growing noisier wherever people look for faults — and for it to allow
-- for a step across every signal at once (the receiver, not the stations), and
-- for more base stations than one.
--
-- 0077 already puts every burst down to the transmitter that put it on the air,
-- by its carrier: the station itself, or the register repeater whose shared
-- carrier it sits on (and nobody, for a copy no repeater explains, a burst two
-- repeaters could have sent, a day with two carriers under one name, a stray).
-- So the SNR goes where the offset goes, and nowhere else. On the live
-- receptions (22–26 Oct 2026) every legacy burst carried an SNR and 85% a
-- carrier; a direct link's daily mean SNR moved a median 1.0 dB day to day
-- (1.8 at the 90th percentile), a burst 1.3 dB about its day's mean, and
-- decodes stopped at about 8.5 dB.
--
-- Five decisions.
--
-- **1. Beside the carrier, in carrier_daily.** roll_up_carriers_day() (0077,
-- 0078) keeps, with each receiver's day of each transmitter, the count, sum
-- and sum of squares of the SNR of the same bursts its offsets come from —
-- strays and mixed days left out the same way, since a burst on another
-- carrier is another transmitter's strength. A station heard only through its
-- repeater has no row and so no SNR; the repeater has its own. Restated whole
-- from 0078 with only that added; the backfill below rebuilds every day whose
-- receptions are still here (from 2026-10-19).
--
-- **2. A link at a time, against its own past.** SNR is a path: a station 12 dB
-- at one base station is 25 at another, so two receivers' numbers never meet.
-- carrier_snr_links() (the service key's: it names receivers) gives each
-- receiver's day of each transmitter against that link's own mean over the
-- window. The change that matters is a link's last week against its thirty
-- days before, or its last thirty days against days 61–90 (antennas go slowly
-- too), and a transmitter's change is its links' weighted by bursts — so a base
-- station that came up last week has no say until it has a history, and adding
-- receivers adds evidence rather than mixing scales.
--
-- **3. Each receiver's own steps taken out, day by day.** A receiver's antenna,
-- cable, gain or noise floor moves every transmitter it hears together. As
-- 0075 does for its crystal: each receiver's shift each day is the median, over
-- the transmitters it heard that day (three or more), of how far each sat from
-- its own mean — and it is taken out before anything is judged. A step on
-- every station at once is the receiver's, and stays in receiver_snr_day (the
-- service key's), which admin_base_station_signal() gives the Base Stations tab
-- with the receiver's noise floor beside it. The receiver key is (token,
-- point, protocol), as 0077's: ALERT and ALERT2 SNR come from two decoders.
--
-- **4. One finding**, `transmitter-snr-falling` (source transmitters, public
-- like the rest — no receiver is named): the week's change or the three
-- months', whichever is worse, at app_meta `tx_snr_drop_warn_db` (3 dB; a
-- week's mean is good to about half a dB) and `tx_snr_drop_crit_db` (6 dB, and
-- most of the base stations judging it agree — one path alone may be the
-- path). It says how many of them saw it, and what the receivers did
-- themselves over the same days.
--
-- **5. Public summary, private links.** transmitter_summary gains the last
-- week's SNR (the base stations together — a level, not a comparison), its
-- burst-to-burst spread, the two changes, how many base stations hear it
-- directly and how many saw the drop, and its line: each day against its
-- thirty days before last week, receivers' shifts out. meganet.carrier_snr()
-- is that line for anyone; the per-receiver numbers stay the service key's.
--
-- Judged by refresh_transmitter_findings() (restated whole from 0082, its SNR
-- added), hourly at minute 13 as before, after roll_up_carriers() at 11. No new
-- pg_cron job.

-- ── After 0082 ───────────────────────────────────────────────────────────────

do $$
begin
  if coalesce((select a.value::integer from meganet.app_meta a where a.key = 'schema_version'), 0) < 82 then
    raise exception '0083 goes in after 0080, 0081 and 0082 — schema_version reads %; apply those first',
      coalesce((select a.value from meganet.app_meta a where a.key = 'schema_version'), 'nothing');
  end if;
end
$$;

-- ── The knobs ────────────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value) values
  ('tx_snr_drop_warn_db', '3'), ('tx_snr_drop_crit_db', '6')
on conflict (key) do nothing;

-- ── The SNR beside the carrier ───────────────────────────────────────────────

alter table meganet.carrier_daily
  add column if not exists snr_n     integer          not null default 0,
  add column if not exists snr_sum   double precision not null default 0,
  add column if not exists snr_sumsq double precision not null default 0;
comment on column meganet.carrier_daily.snr_n is
  'How many of the day''s bursts kept for the offset carried an SNR (0083): the same bursts, strays left out.';
comment on column meganet.carrier_daily.snr_sum is 'Sum of those bursts'' snr_db (0083).';
comment on column meganet.carrier_daily.snr_sumsq is 'Sum of the squares of those bursts'' snr_db (0083): their spread, with snr_n and snr_sum.';

alter table meganet.transmitter_summary
  add column if not exists snr_db        double precision,
  add column if not exists snr_sd        double precision,
  add column if not exists snr_change_db double precision,
  add column if not exists snr_season_db double precision,
  add column if not exists snr_receivers integer not null default 0,
  add column if not exists snr_judged    integer not null default 0,
  add column if not exists snr_falling   integer not null default 0,
  add column if not exists snr_days      date[]  not null default '{}',
  add column if not exists snr_rel       real[]  not null default '{}';
comment on column meganet.transmitter_summary.snr_db is
  'Its SNR over the last 7 days, dB over the receiver''s noise, the base stations that hear it on its own carrier together (0083). A level to read, not to compare across stations.';
comment on column meganet.transmitter_summary.snr_sd is 'Its bursts'' spread about each day''s mean over the last 7 days, dB (0083).';
comment on column meganet.transmitter_summary.snr_change_db is
  'Its last 7 days against the 30 before, dB, each receiver''s own shifts taken out, its links weighted by bursts (0083). Null until a link has 3 and 5 days.';
comment on column meganet.transmitter_summary.snr_season_db is
  'Its last 30 days against days 61–90, dB, the same way (0083). Null until a link has 10 and 10 days.';
comment on column meganet.transmitter_summary.snr_receivers is 'Base stations that heard it on its own carrier in the last 7 days (0083).';
comment on column meganet.transmitter_summary.snr_judged is 'Of those, how many had enough days for the week''s change (0083).';
comment on column meganet.transmitter_summary.snr_falling is 'Of those judged, how many saw it fall by tx_snr_drop_warn_db (0083).';
comment on column meganet.transmitter_summary.snr_rel is
  'Its line: each day of snr_days in dB against its 30 days before last week, the base stations together, receivers'' shifts out (0083).';

create table if not exists meganet.receiver_snr_day (
  day              date             not null,
  ingest_token_id  bigint           not null,
  point_id         text             not null,
  protocol         text             not null check (protocol in ('alert', 'alert2')),
  shift_db         double precision not null,
  links            integer          not null,
  bursts           bigint           not null,
  judged_at        timestamptz      not null,
  primary key (day, ingest_token_id, point_id, protocol)
);
comment on table meganet.receiver_snr_day is
  'Each receiver''s own SNR shift by day (0083): the median of how far every transmitter it heard on its own carrier sat from its usual — the step a receiver, its antenna, cable, gain or noise takes on everything at once — against its mean over the last 97 days. What carrier_snr_links() takes out before a transmitter is judged. Rebuilt by refresh_transmitter_findings(). The service key''s: it names receivers.';
alter table meganet.receiver_snr_day enable row level security;

-- ── The health finding ───────────────────────────────────────────────────────

alter table meganet.health_finding drop constraint if exists health_finding_kind;
alter table meganet.health_finding add constraint health_finding_kind
  check (kind ~ '^[a-z][a-z0-9-]{1,39}$'
         and (source = 'stations'
              or (source = 'base-stations' and kind in ('base-station-quiet', 'receiver-deaf'))
              or (source = 'transmitters' and kind in ('transmitter-off-channel', 'transmitter-drift', 'transmitter-corrupting',
                                                        'transmitter-snr-falling'))));

-- ── A link's days ────────────────────────────────────────────────────────────

create or replace function meganet.carrier_snr_links(p_days integer default 97)
returns table (ingest_token_id bigint, point_id text, protocol text, tx text, station_id text, via text, day date,
               bursts bigint, snr_db double precision, var_db double precision,
               rx_shift_db double precision, rx_links integer, rel_db double precision)
language sql
stable
security definer
set search_path = ''
as $$
  -- snr(link, day) = the link's own level + the receiver's shift that day +
  -- the transmitter's change + noise. A link is a receiver — (token, point,
  -- protocol) — and a transmitter on its own carrier.
  with t as (
    select c.day as d, c.ingest_token_id as tok, c.point_id as pt, c.protocol as pr, c.tx as a, c.station_id as sid, c.via,
           c.snr_n::bigint as n, c.snr_sum / c.snr_n as s,
           greatest(c.snr_sumsq / c.snr_n - (c.snr_sum / c.snr_n) * (c.snr_sum / c.snr_n), 0) as v
      from meganet.carrier_daily c
     where not c.mixed and c.snr_n >= 3
       and c.day >= (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 97), 1), 400)
  ), m0 as (
    -- A first guess at each link: its mean over the window.
    select t.tok, t.pt, t.pr, t.a, pg_catalog.sum(t.s * t.n) / pg_catalog.sum(t.n) as m from t group by 1, 2, 3, 4
  ), e as (
    -- The receiver's shift each day: the median of how far its links sat from
    -- their own means that day. Three links or more.
    select t.tok, t.pt, t.pr, t.d, pg_catalog.percentile_cont(0.5) within group (order by t.s - m0.m) as e, pg_catalog.count(*) as k
      from t join m0 on m0.tok = t.tok and m0.pt = t.pt and m0.pr = t.pr and m0.a = t.a
     group by 1, 2, 3, 4
  ), m1 as (
    -- Each link again, with the receiver's shifts taken out.
    select t.tok, t.pt, t.pr, t.a, pg_catalog.sum((t.s - e.e) * t.n) / pg_catalog.sum(t.n) as m
      from t join e on e.tok = t.tok and e.pt = t.pt and e.pr = t.pr and e.d = t.d
     where e.k >= 3
     group by 1, 2, 3, 4
  )
  select t.tok, t.pt, t.pr, t.a, t.sid, t.via, t.d, t.n, t.s, t.v, e.e, e.k::integer, t.s - e.e - m1.m
    from t
    join e  on e.tok = t.tok and e.pt = t.pt and e.pr = t.pr and e.d = t.d
    join m1 on m1.tok = t.tok and m1.pt = t.pt and m1.pr = t.pr and m1.a = t.a
   where e.k >= 3;
$$;

comment on function meganet.carrier_snr_links(integer) is
  'Each receiver''s day of each transmitter it heard on that transmitter''s own carrier, over the last p_days (0083): bursts, mean SNR and its variance, the receiver''s own shift that day (the median of its links'' moves, three or more) and the link''s day against its own mean with that shift taken out. From carrier_daily, mixed days left out; at most 400 days. The service key''s: it names receivers.';

-- ── A transmitter's days, for anyone ─────────────────────────────────────────

create or replace function meganet.carrier_snr(p_days integer default 97)
returns table (tx text, protocol text, station_id text, via text, day date, snr_db double precision, rel_db double precision,
               sd_db double precision, bursts bigint, receivers integer)
language sql
stable
security definer
set search_path = ''
as $$
  select l.tx, pg_catalog.min(l.protocol), pg_catalog.min(l.station_id), pg_catalog.max(l.via), l.day,
         pg_catalog.sum(l.snr_db * l.bursts) / pg_catalog.sum(l.bursts),
         pg_catalog.sum(l.rel_db * l.bursts) / pg_catalog.sum(l.bursts),
         pg_catalog.sqrt(pg_catalog.sum(l.var_db * l.bursts) / pg_catalog.sum(l.bursts)),
         pg_catalog.sum(l.bursts)::bigint, pg_catalog.count(*)::integer
    from meganet.carrier_snr_links(p_days) l
   group by l.tx, l.day
   order by l.tx, l.day;
$$;

comment on function meganet.carrier_snr(integer) is
  'Each transmitter''s SNR by UTC day over the last p_days (0083), only from bursts its own carrier says it sent — legacy stations and repeaters (st:, a:) and ALERT2 (a2:): the mean as heard, the base stations together, and its day against its usual with each receiver''s own shifts taken out. Public: no receiver is named.';

-- ── A base station's receivers, for the Base Stations tab ────────────────────

create or replace function meganet.admin_base_station_signal(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform meganet.admin_require();
  if not exists (select 1 from meganet.ingest_token t where t.id = p_id) then
    raise exception 'no ingest token %', p_id using errcode = '22023';
  end if;

  -- Each receiver and protocol: its days — [day, shift dB, transmitters it
  -- was judged from, their bursts, its noise floor dBFS that day].
  select pg_catalog.jsonb_build_object(
           'now', pg_catalog.now(),
           'judged_at', (select pg_catalog.max(d.judged_at) from meganet.receiver_snr_day d where d.ingest_token_id = p_id),
           'warn_db', coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_snr_drop_warn_db'), 3),
           'receivers', coalesce(pg_catalog.jsonb_agg(x.o order by x.point_id, x.protocol), '[]'::jsonb))
    into v
    from (select d.point_id, d.protocol,
                 pg_catalog.jsonb_build_object(
                   'point_id', d.point_id, 'protocol', d.protocol,
                   'name', (select p.name from meganet.ingest_point_latest p where p.ingest_token_id = p_id and p.point_id = d.point_id),
                   'days', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                             d.day, pg_catalog.round(d.shift_db::numeric, 2), d.links, d.bursts,
                             (select pg_catalog.round((pg_catalog.sum(h.nf_dbfs_sum) / nullif(pg_catalog.sum(h.nf_dbfs_n), 0))::numeric, 1)
                                from meganet.reception_daily h
                               where h.ingest_token_id = p_id and h.point_id = d.point_id and h.bucket = d.day))
                           order by d.day)) as o
            from meganet.receiver_snr_day d
           where d.ingest_token_id = p_id
           group by d.point_id, d.protocol) x;
  return v;
end;
$$;

comment on function meganet.admin_base_station_signal(bigint) is
  'A base station''s receivers'' own SNR shifts by day (0083, receiver_snr_day): a step on everything a receiver hears at once is the receiver — its antenna, cable, gain or the noise at its site — and its noise floor (reception_daily) is beside each day to tell which. Administrators only.';

-- ── Rolling a day up, the SNR beside the offsets (restated from 0078) ────────

create or replace function meganet.roll_up_carriers_day(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_tol   constant double precision := 30;    -- Hz either side of a carrier
  c_bin   constant integer := 5;              -- Hz a histogram bin
  c_win   constant integer := 6;              -- bins either side: ±30 Hz
  c_out   constant double precision := 60;    -- Hz from the day's median: another carrier
  c_spread constant double precision := 35;   -- Hz: a day's spread wider than this is two carriers close together
  v_t0    timestamptz := (p_day::text || ' 00:00:00+00')::timestamptz;   -- the UTC day, whatever the session's zone
  v_out   jsonb;
begin
  -- A day whose receptions are gone is never rebuilt: what is kept is all there is.
  if exists (select 1 from meganet.archive_day ad where ad.table_name = 'reception' and ad.day = p_day and ad.released_at is not null)
     or not exists (select 1 from meganet.reception r where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day') then
    return pg_catalog.jsonb_build_object('day', p_day, 'skipped', 'no receptions left for this day');
  end if;

  -- ── Flipped copies, first (0078) ─────────────────────────────────────────
  -- Every legacy burst of the day, and five seconds either side of it (a pair
  -- across midnight is found on both days, and kept on the day its corrupted
  -- burst was heard), offset or not: an address and a value, as the 24 bits a
  -- frame carries them in.
  drop table if exists pg_temp._fb;
  create temporary table _fb on commit drop as
  select r.id, r.ingest_token_id as tok, r.point_id as rx, r.heard_at as t, r.alert_id as a, r.value_raw as v,
         ((r.alert_id & 8191) << 11) | (r.value_raw & 2047) as w,
         r.cfo_hz::double precision as cfo, r.snr_db::double precision as snr, coalesce(r.a2_duplicate, false) as dup
    from meganet.reception r
   where r.heard_at >= v_t0 - interval '5 seconds' and r.heard_at < v_t0 + interval '1 day' + interval '5 seconds'
     and r.protocol = 'alert' and r.ok and r.ingest_token_id is not null
     and r.alert_id between 0 and 8191 and r.value_raw between 0 and 2047;
  create index on _fb (tok, rx, t);
  analyze _fb;

  -- Two bursts on one receiver within five seconds, one or two bits apart:
  -- one is the other, corrupted. Which, by the first rule that decides:
  --   same-station  both addresses are one station's and the values differ
  --                 (its sensors in one burst): not a flip;
  --   rapid         one address, both values in line with its last reading:
  --                 two real reports (a gauge tipping twice), not a flip;
  --   ghost         one address is on no station: that one;
  --   silent-address  both on stations, one not heard for a week: that one;
  --   fit           one value within 8 counts of its address's last reading,
  --                 the other more than 32 from its own: the other;
  --   copies        the version heard more often (any receiver, ±12 s) is
  --                 the true one;
  -- and otherwise undecided (`ambiguous`), never guessed.
  drop table if exists pg_temp._fp;
  create temporary table _fp on commit drop as
  with p as (
    select x.id as xid, y.id as yid, x.tok, x.rx, x.t as xt, y.t as yt, x.a as xa, x.v as xv, y.a as ya, y.v as yv,
           pg_catalog.bit_count((x.w # y.w)::bit(24))::integer as bits
      from _fb x
      join _fb y on y.tok = x.tok and y.rx = x.rx and y.t <= x.t + interval '5 seconds'
                and (y.t > x.t or (y.t = x.t and y.id > x.id))
     where x.w <> y.w
  ), q as (
    select p.*,
           exists (select 1 from meganet.sensor se join meganet.station st on st.id = se.station_id and st.deleted_at is null
                    where se.alert_id = p.xa) as xreg,
           exists (select 1 from meganet.sensor se join meganet.station st on st.id = se.station_id and st.deleted_at is null
                    where se.alert_id = p.ya) as yreg,
           -- One station's two sensors in one burst carry two values; the same
           -- value on its neighbouring address is that one corrupted.
           p.xa <> p.ya and p.xv <> p.yv
             and exists (select 1 from meganet.sensor s1 join meganet.sensor s2 on s2.station_id = s1.station_id
                          where s1.alert_id = p.xa and s2.alert_id = p.ya) as samest,
           (select r.value_raw from meganet.reading r where r.addr = 'a:' || p.xa
               and r.reading_ts < p.xt - interval '30 seconds' and r.reading_ts > p.xt - interval '7 days'
             order by r.reading_ts desc limit 1) as xp,
           (select r.value_raw from meganet.reading r where r.addr = 'a:' || p.ya
               and r.reading_ts < p.xt - interval '30 seconds' and r.reading_ts > p.xt - interval '7 days'
             order by r.reading_ts desc limit 1) as yp,
           (select pg_catalog.count(*) from meganet.reception r where r.protocol = 'alert' and r.alert_id = p.xa and r.value_raw = p.xv
               and r.heard_at between p.xt - interval '12 seconds' and p.xt + interval '12 seconds') as xc,
           (select pg_catalog.count(*) from meganet.reception r where r.protocol = 'alert' and r.alert_id = p.ya and r.value_raw = p.yv
               and r.heard_at between p.yt - interval '12 seconds' and p.yt + interval '12 seconds') as yc
      from p where p.bits <= 2
  )
  select q.*,
         case when q.samest then 'same-station'
              when q.xa = q.ya and q.xp is not null and pg_catalog.abs(q.xv - q.xp) <= 8 and pg_catalog.abs(q.yv - q.xp) <= 8 then 'rapid'
              when q.xreg <> q.yreg then 'ghost'
              when q.xreg and q.yreg and (q.xp is null) <> (q.yp is null) then 'silent-address'
              when q.xp is not null and q.yp is not null
                   and ((pg_catalog.abs(q.xv - q.xp) <= 8 and pg_catalog.abs(q.yv - q.yp) > 32)
                     or (pg_catalog.abs(q.yv - q.yp) <= 8 and pg_catalog.abs(q.xv - q.xp) > 32)) then 'fit'
              when q.xc <> q.yc then 'copies'
              else 'ambiguous' end as rule,
         case when q.samest then null
              when q.xa = q.ya and q.xp is not null and pg_catalog.abs(q.xv - q.xp) <= 8 and pg_catalog.abs(q.yv - q.xp) <= 8 then null
              when q.xreg and not q.yreg then 'y'
              when q.yreg and not q.xreg then 'x'
              when q.xreg and q.yreg and q.xp is not null and q.yp is null then 'y'
              when q.xreg and q.yreg and q.yp is not null and q.xp is null then 'x'
              when q.xp is not null and q.yp is not null and pg_catalog.abs(q.xv - q.xp) <= 8 and pg_catalog.abs(q.yv - q.yp) > 32 then 'y'
              when q.xp is not null and q.yp is not null and pg_catalog.abs(q.yv - q.yp) <= 8 and pg_catalog.abs(q.xv - q.xp) > 32 then 'x'
              when q.xc > q.yc then 'y'
              when q.yc > q.xc then 'x' end as bad
    from q;

  -- A burst judged corrupted in one pair and true in another is not sure, and
  -- neither is any pair it is in: those pairs are set aside (`unsure`). The
  -- corrupted bursts are the bad sides of the rest.
  drop table if exists pg_temp._funsure;
  create temporary table _funsure on commit drop as
  select case when f.bad = 'x' then f.xid else f.yid end as id from _fp f where f.bad is not null
  intersect
  select case when f.bad = 'x' then f.yid else f.xid end from _fp f where f.bad is not null;
  update _fp f set bad = null, rule = 'unsure'
   where f.bad is not null and (f.xid in (select u.id from _funsure u) or f.yid in (select u.id from _funsure u));
  drop table if exists pg_temp._fbad;
  create temporary table _fbad on commit drop as
  select distinct case when f.bad = 'x' then f.xid else f.yid end as id from _fp f where f.bad is not null;

  -- The day's legacy bursts with an offset, and their SNR (0083).
  drop table if exists pg_temp._cb;
  create temporary table _cb on commit drop as
  select r.id, r.ingest_token_id as tok, r.point_id as rx, r.alert_id as a,
         coalesce(r.a2_duplicate, false) as dup, r.cfo_hz::double precision as cfo, r.freq_mhz as f,
         r.snr_db::double precision as snr
    from meganet.reception r
   where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day'
     and r.protocol = 'alert' and r.ok and r.alert_id is not null and r.cfo_hz is not null
     and r.ingest_token_id is not null
     and not exists (select 1 from _fbad x where x.id = r.id);   -- a corrupted copy names the wrong address (0078)

  -- The register's repeaters: what each passes, and its own sensors.
  drop table if exists pg_temp._rp;
  create temporary table _rp on commit drop as
  select s.id as rid,
         coalesce((select pg_catalog.array_agg(distinct se.alert_id) from meganet.sensor se
                    where se.station_id = s.id and se.alert_id is not null), '{}'::integer[]) as own
    from meganet.repeater rep
    join meganet.station s on s.id = rep.station_id and s.deleted_at is null;

  -- Which repeaters pass another's own sensors: B relays A when one of A's
  -- addresses is in B's pass range (and not excluded).
  drop table if exists pg_temp._relays;
  create temporary table _relays on commit drop as
  select distinct a.rid as relayed, p.repeater_id as by
    from _rp a
    cross join lateral pg_catalog.unnest(a.own) o(addr)
    join meganet.pass_range p on p.kind = 'pass' and o.addr between p.lo and p.hi and p.repeater_id <> a.rid
    join _rp b on b.rid = p.repeater_id
   where not exists (select 1 from meganet.pass_range e
                      where e.repeater_id = p.repeater_id and e.kind = 'exclusion' and o.addr between e.lo and e.hi);

  -- Every burst a repeater might have sent: an address it passes (and does not
  -- exclude), or one of its own — its own an anchor only when nobody else
  -- passes it.
  drop table if exists pg_temp._cand;
  create temporary table _cand on commit drop as
  select distinct b.id, b.tok, b.rx, x.rid, b.a, b.cfo,
         x.is_own and not exists (select 1 from _relays rl where rl.relayed = x.rid) as anchor,
         pg_catalog.floor(b.cfo / c_bin)::integer as bin
    from _cb b
    join lateral (
      select rp.rid, true as is_own from _rp rp where b.a = any (rp.own)
      union all
      select p.repeater_id, false from meganet.pass_range p
        join _rp rp on rp.rid = p.repeater_id
       where p.kind = 'pass' and b.a between p.lo and p.hi
         and not (b.a = any (rp.own))
         and not exists (select 1 from meganet.pass_range e
                          where e.repeater_id = p.repeater_id and e.kind = 'exclusion' and b.a between e.lo and e.hi)
    ) x on true;

  -- For each receiver and repeater, the ±30 Hz window holding the most
  -- addresses: counted over each address's bins, not its bursts.
  drop table if exists pg_temp._rep;
  create temporary table _rep on commit drop as
  with idbin as (
    select distinct c.tok, c.rx, c.rid, c.a, c.anchor, c.bin from _cand c
  ), heard as (
    select i.tok, i.rx, i.rid, pg_catalog.count(distinct i.a) filter (where not i.anchor) as nids
      from idbin i group by 1, 2, 3
  ), bins as (
    select distinct i.tok, i.rx, i.rid, i.bin from idbin i
  ), win as (
    select k.tok, k.rx, k.rid, k.bin,
           pg_catalog.count(distinct i.a) filter (where not i.anchor) as ids,
           pg_catalog.count(distinct i.a) filter (where i.anchor) as own_ids
      from bins k
      join idbin i on i.tok = k.tok and i.rx = k.rx and i.rid = k.rid
                  and i.bin between k.bin - c_win and k.bin + c_win
     group by 1, 2, 3, 4
  ), best as (
    select distinct on (w.tok, w.rx, w.rid) w.*
      from win w
     order by w.tok, w.rx, w.rid, (w.own_ids > 0) desc, w.ids desc, w.bin
  )
  select b.tok, b.rx, b.rid, b.ids, b.own_ids, h.nids,
         (select pg_catalog.percentile_cont(0.5) within group (order by c.cfo)
            from _cand c where c.tok = b.tok and c.rx = b.rx and c.rid = b.rid
             and c.bin between b.bin - c_win and b.bin + c_win) as centre,
         true as keep
    from best b join heard h on h.tok = b.tok and h.rx = b.rx and h.rid = b.rid
   where b.own_ids > 0 or (b.ids >= 4 and b.ids >= 0.5 * h.nids);

  -- Two repeaters on one carrier are one transmitter: the one that relays the
  -- other's sensors; else the one heard on its own; else neither.
  update _rep r set keep = false
   where exists (select 1 from _rep o
                  where o.tok = r.tok and o.rx = r.rx and o.rid <> r.rid
                    and pg_catalog.abs(o.centre - r.centre) <= 2 * c_tol
                    and (exists (select 1 from _relays x where x.relayed = r.rid and x.by = o.rid)
                         or not ((r.own_ids > 0 and o.own_ids = 0)
                                 or exists (select 1 from _relays x where x.relayed = o.rid and x.by = r.rid))));
  delete from _rep where not keep;

  -- Each burst to its transmitter.
  drop table if exists pg_temp._as;
  create temporary table _as on commit drop as
  with claim as (
    select c.id, pg_catalog.count(*) as k, pg_catalog.min(c.rid) as rid
      from _cand c
      join _rep r on r.tok = c.tok and r.rx = c.rx and r.rid = c.rid
     where pg_catalog.abs(c.cfo - r.centre) <= c_tol
     group by c.id
  )
  select b.tok, b.rx, b.a, b.cfo, b.f, b.snr,
         case when cl.k = 1 then 'repeater'
              when cl.k > 1 then 'ambiguous'
              when b.dup then 'unexplained'
              else 'own' end as how,
         case when cl.k = 1 then 'st:' || cl.rid
              when cl.k is null and not b.dup then coalesce('st:' || meganet.resolve_station(b.a, null), 'a:' || b.a)
         end as tx
    from _cb b left join claim cl on cl.id = b.id;

  -- This day's rows, again.
  delete from meganet.carrier_daily where day = p_day;
  delete from meganet.carrier_receiver_day where day = p_day;

  -- Both kinds, a burst a row: legacy as put down above, ALERT2 to its path's
  -- last address or its source (0075).
  drop table if exists pg_temp._all;
  create temporary table _all on commit drop as
  select s.tok, s.rx, s.tx, 'alert'::text as protocol, s.how, s.a, s.cfo, s.f, s.snr
    from _as s where s.tx is not null
  union all
  select q.tok, q.rx, 'a2:' || q.a, 'alert2', 'path', q.a, q.cfo, q.f, q.snr
    from (select r.ingest_token_id as tok, r.point_id as rx,
                 coalesce(r.a2_path[pg_catalog.array_length(r.a2_path, 1)], r.a2_source) as a,
                 r.cfo_hz::double precision as cfo, r.freq_mhz as f, r.snr_db::double precision as snr
            from meganet.reception r
           where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day'
             and r.protocol = 'alert2' and r.cfo_hz is not null and r.ingest_token_id is not null) q
   where q.a is not null;

  -- A day a transmitter: strays from its median left out, and a day with too
  -- many of them — another carrier under its name — marked mixed. The SNR of
  -- the bursts kept beside the offsets (0083): a stray is another carrier's,
  -- so its strength is another transmitter's too.
  insert into meganet.carrier_daily (day, ingest_token_id, point_id, tx, protocol, station_id, via, n, cfo_sum, cfo_sumsq, ids, mixed, n_out, freq_mhz,
                                     snr_n, snr_sum, snr_sumsq)
  with g as (
    select x.tok, x.rx, x.tx, pg_catalog.percentile_cont(0.5) within group (order by x.cfo) as med
      from _all x group by 1, 2, 3
  ), y as (
    select x.*, pg_catalog.abs(x.cfo - g.med) > c_out as stray
      from _all x join g on g.tok = x.tok and g.rx = x.rx and g.tx = x.tx
  )
  select p_day, y.tok, y.rx, y.tx, pg_catalog.min(y.protocol),
         case when y.tx like 'st:%' then pg_catalog.substr(y.tx, 4)
              when y.tx like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(y.tx, 4)::integer) end,
         pg_catalog.max(y.how),
         pg_catalog.count(*) filter (where not y.stray)::integer,
         coalesce(pg_catalog.sum(y.cfo) filter (where not y.stray), 0),
         coalesce(pg_catalog.sum(y.cfo * y.cfo) filter (where not y.stray), 0),
         pg_catalog.count(distinct y.a)::integer,
         pg_catalog.count(*) filter (where y.stray) >= greatest(2, 0.1 * pg_catalog.count(*))
           or (pg_catalog.count(*) filter (where not y.stray) >= 4
               and pg_catalog.stddev_pop(y.cfo) filter (where not y.stray) > c_spread),
         pg_catalog.count(*) filter (where y.stray)::integer,
         pg_catalog.max(y.f),
         pg_catalog.count(y.snr) filter (where not y.stray)::integer,
         coalesce(pg_catalog.sum(y.snr) filter (where not y.stray), 0),
         coalesce(pg_catalog.sum(y.snr * y.snr) filter (where not y.stray), 0)
    from y
   group by y.tok, y.rx, y.tx;

  -- ── Who sent each corrupted copy (0078) ────────────────────────────────────
  -- By its carrier: of the transmitters that could have sent the true
  -- reading — its station, the repeaters that pass it — the one this receiver
  -- heard that day nearest the corrupted burst's offset, within 40 Hz.
  delete from meganet.flip_event where day = p_day;
  insert into meganet.flip_event (day, ingest_token_id, point_id, heard_at, true_addr, true_value, bad_addr, bad_value, bits,
                                  addr_flip, gap_s, rule, bad_reception_id, good_reception_id, bad_snr, good_snr,
                                  bad_cfo, good_cfo, bad_copy, bad_tx, bad_how, good_tx)
  -- One event a corrupted burst: it pairs with every clean copy of its
  -- reading in the window (the station's, each repeater's), and the nearest is
  -- the one it was made from, or nearest to it.
  select distinct on (b.id) p_day, b.tok, b.rx, b.t, g.a, g.v, b.a, b.v, f.bits, g.a <> b.a,
         extract(epoch from b.t - g.t)::real, f.rule, b.id, g.id, b.snr::real, g.snr::real, b.cfo::real, g.cfo::real, b.dup,
         case when b.cfo is not null and meganet.carrier_tx(p_day, b.tok, b.rx, g.a, b.cfo) <> '?' then meganet.carrier_tx(p_day, b.tok, b.rx, g.a, b.cfo) end,
         case when b.cfo is null then 'no-carrier'
              when meganet.carrier_tx(p_day, b.tok, b.rx, g.a, b.cfo) is null then 'unmatched'
              when meganet.carrier_tx(p_day, b.tok, b.rx, g.a, b.cfo) = '?' then 'ambiguous' else 'carrier' end,
         nullif(case when g.cfo is not null then meganet.carrier_tx((g.t at time zone 'UTC')::date, g.tok, g.rx, g.a, g.cfo) end, '?')
    from _fp f
    join _fb b on b.id = case when f.bad = 'x' then f.xid else f.yid end
    join _fb g on g.id = case when f.bad = 'x' then f.yid else f.xid end
   where f.bad is not null and b.t >= v_t0 and b.t < v_t0 + interval '1 day'
   order by b.id, pg_catalog.abs(extract(epoch from b.t - g.t)), g.id
  on conflict do nothing;

  -- What was found, per receiver.
  insert into meganet.carrier_receiver_day (day, ingest_token_id, point_id, detail)
  select p_day, g.tok, g.rx, pg_catalog.jsonb_build_object(
           'bursts', g.n, 'own', g.own, 'repeater', g.rep, 'ambiguous', g.amb, 'unexplained', g.unx,
           'split', (select pg_catalog.count(*) from meganet.reception r
                      where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day' and r.protocol = 'alert'
                        and r.ingest_token_id = g.tok and r.point_id = g.rx and r.detail ? 'cfo_split'),
           'flips', (select pg_catalog.jsonb_build_object(
                'pairs', pg_catalog.count(*) filter (where f.rule not in ('same-station', 'rapid')),
                'decided', pg_catalog.count(*) filter (where f.bad is not null),
                'ambiguous', pg_catalog.count(*) filter (where f.rule = 'ambiguous'),
                'not_flips', pg_catalog.count(*) filter (where f.rule in ('same-station', 'rapid')),
                'by_rule', coalesce((select pg_catalog.jsonb_object_agg(z.rule, z.n) from
                    (select f2.rule, pg_catalog.count(*) as n from _fp f2 where f2.tok = g.tok and f2.rx = g.rx group by 1) z), '{}'::jsonb))
              from _fp f where f.tok = g.tok and f.rx = g.rx),
           'repeaters', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'station_id', r.rid, 'centre_hz', pg_catalog.round(r.centre::numeric), 'addresses', r.ids,
                'own_addresses', r.own_ids, 'passes_heard', r.nids) order by r.rid)
              from _rep r where r.tok = g.tok and r.rx = g.rx), '[]'::jsonb))
    from (select k.tok, k.rx, pg_catalog.count(s.tx) + pg_catalog.count(*) filter (where s.how is not null and s.tx is null) as n,
                 pg_catalog.count(*) filter (where s.how = 'own') as own,
                 pg_catalog.count(*) filter (where s.how = 'repeater') as rep,
                 pg_catalog.count(*) filter (where s.how = 'ambiguous') as amb,
                 pg_catalog.count(*) filter (where s.how = 'unexplained') as unx
            from (select b.tok, b.rx from _fb b where b.t >= v_t0 union select c.tok, c.rx from _cb c) k
            left join _as s on s.tok = k.tok and s.rx = k.rx
           group by 1, 2) g;

  select pg_catalog.jsonb_build_object('day', p_day,
           'legacy_bursts', (select pg_catalog.count(*) from _cb),
           'flips', (select pg_catalog.count(*) from meganet.flip_event fe where fe.day = p_day),
           'repeaters_found', (select pg_catalog.count(*) from _rep),
           'rows', (select pg_catalog.count(*) from meganet.carrier_daily where day = p_day))
    into v_out;
  return v_out;
end;
$$;

comment on function meganet.roll_up_carriers_day(date) is
  'Rebuilds one UTC day from its receptions (0077, 0078, 0083): the corrupted copies first (flip_event) — left out of the carriers — then each legacy burst put down to its station or the register repeater whose shared carrier it sits on, ALERT2 to its path''s last address (carrier_daily, with the SNR of the same bursts), then each corrupted copy put down to the transmitter whose carrier it came on. Idempotent; a day whose receptions are gone is skipped. The service key''s.';

-- ── The findings, with the signal (restated from 0082) ───────────────────────

create or replace function meganet.refresh_transmitter_findings(p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := pg_catalog.clock_timestamp();
  v_today   date := (p_now at time zone 'UTC')::date;
  v_ow      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_offset_warn_ppm'), 2.5);
  v_oc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_offset_crit_ppm'), 5);
  v_dw      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_drift_warn_ppm'), 1);
  v_dc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_drift_crit_ppm'), 2);
  t         record;
  v_sid     text;
  v_name    text;
  v_judged  integer := 0;
  v_out     jsonb;
  v_took    integer;
  v_fleet   double precision;
  v_fmin    integer := coalesce((select a.value::integer from meganet.app_meta a where a.key = 'tx_flip_min'), 5);
  v_fw      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_flip_warn_rate'), 0.02);
  v_fc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_flip_crit_rate'), 0.10);
  v_sw      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_snr_drop_warn_db'), 3);
  v_sc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_snr_drop_crit_db'), 6);
  v_wk      boolean;
  v_drop    double precision;
  v_jn      integer;
  v_fn      integer;
  v_shift   double precision;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(5900217) then
    return pg_catalog.jsonb_build_object('at', p_now, 'skipped', 'another run is under way');
  end if;
  perform meganet.health_begin();

  drop table if exists pg_temp._ts;
  create temporary table _ts on commit drop as
  with s as (select * from meganet.carrier_offsets(38))
  select s.tx, pg_catalog.min(s.protocol) as protocol, pg_catalog.min(s.station_id) as station_id, pg_catalog.max(s.via) as via,
         pg_catalog.count(*) filter (where s.day > v_today - 7)::integer                                as w_days,
         pg_catalog.sum(s.offset_ppm * s.bursts) filter (where s.day > v_today - 7)
           / nullif(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)                     as w_ppm,
         pg_catalog.sum(s.offset_hz * s.bursts) filter (where s.day > v_today - 7)
           / nullif(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)                     as w_hz,
         pg_catalog.count(*) filter (where s.day <= v_today - 7 and s.day > v_today - 37)::integer       as b_days,
         pg_catalog.sum(s.offset_ppm * s.bursts) filter (where s.day <= v_today - 7 and s.day > v_today - 37)
           / nullif(pg_catalog.sum(s.bursts) filter (where s.day <= v_today - 7 and s.day > v_today - 37), 0) as b_ppm,
         coalesce(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)::bigint                as w_bursts,
         coalesce(pg_catalog.max(s.receivers) filter (where s.day > v_today - 7), 0)::integer            as receivers,
         pg_catalog.max(s.freq_mhz)                                                                     as freq,
         pg_catalog.array_agg(s.day order by s.day)                                                     as days,
         pg_catalog.array_agg(pg_catalog.round(s.offset_ppm::numeric, 3)::real order by s.day)           as ppm
    from s group by s.tx;

  for t in select * from _ts loop
    continue when coalesce(t.w_days, 0) = 0;
    v_judged := v_judged + 1;
    v_sid := case when t.tx like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(t.tx, 4)::integer)
                  when t.tx like 'st:%' then pg_catalog.substr(t.tx, 4) end;
    v_name := (select st.name from meganet.station st where st.id = v_sid);
    v_name := case when t.tx like 'a2:%' then 'ALERT2 ' || pg_catalog.substr(t.tx, 4) || coalesce(' (' || nullif(v_name, '') || ')', '')
                   when t.tx like 'a:%'  then 'ALERT ' || pg_catalog.substr(t.tx, 3)
                   else coalesce(nullif(v_name, ''), pg_catalog.substr(t.tx, 4)) end;

    if t.w_days >= 2 and pg_catalog.abs(t.w_ppm) >= v_ow then
      insert into pg_temp._health_now values (
        'transmitter-off-channel', t.tx, v_sid, null, null,
        case when pg_catalog.abs(t.w_ppm) >= v_oc then 'critical' else 'warn' end,
        v_name || ': transmitting ' || pg_catalog.to_char(t.w_ppm, 'FMSG9990.0') || ' ppm off the others ('
          || pg_catalog.to_char(t.w_hz, 'FMSG999990') || ' Hz)',
        'Over the last ' || t.w_days || ' days its carrier has been ' || pg_catalog.round(pg_catalog.abs(t.w_hz))::text
          || ' Hz ' || case when t.w_hz > 0 then 'above' else 'below' end || ' the other transmitters the same receivers hear — '
          || pg_catalog.to_char(pg_catalog.abs(t.w_ppm), 'FM990.0') || ' ppm at ' || pg_catalog.to_char(t.freq, 'FM990.0000')
          || ' MHz. A transmitter this far off decodes worse and then not at all; its frequency wants checking at the next visit.',
        pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', t.protocol, 'via', t.via, 'category', 'comms',
          'action', 'Check the transmitter''s frequency at the next visit; a crystal this far off is due for replacement.',
          'offset_ppm', pg_catalog.round(t.w_ppm::numeric, 2), 'offset_hz', pg_catalog.round(t.w_hz::numeric),
          'days', t.w_days, 'bursts', t.w_bursts, 'receivers', t.receivers, 'freq_mhz', t.freq,
          'warn_ppm', v_ow, 'critical_ppm', v_oc)
          || case when t.tx like 'a2:%' then pg_catalog.jsonb_build_object('addr', pg_catalog.substr(t.tx, 4)::integer) else '{}'::jsonb end);
    end if;

    if t.w_days >= 3 and t.b_days >= 5 and pg_catalog.abs(t.w_ppm - t.b_ppm) >= v_dw then
      insert into pg_temp._health_now values (
        'transmitter-drift', t.tx, v_sid, null, null,
        case when pg_catalog.abs(t.w_ppm - t.b_ppm) >= v_dc then 'critical' else 'warn' end,
        v_name || ': drifted ' || pg_catalog.to_char(t.w_ppm - t.b_ppm, 'FMSG9990.0') || ' ppm in a week',
        'Its carrier offset against the other transmitters was ' || pg_catalog.to_char(t.b_ppm, 'FMSG9990.00') || ' ppm over the '
          || t.b_days || ' days before last week, and ' || pg_catalog.to_char(t.w_ppm, 'FMSG9990.00') || ' ppm over the last '
          || t.w_days || '. A crystal moving this fast is ageing or failing, or the site is running hot or cold; it tends to end in silence.',
        pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', t.protocol, 'via', t.via, 'category', 'comms',
          'action', 'Its crystal is moving: check the frequency soon, and the site''s temperature and power — before it goes quiet.',
          'recent_ppm', pg_catalog.round(t.w_ppm::numeric, 2), 'earlier_ppm', pg_catalog.round(t.b_ppm::numeric, 2),
          'recent_days', t.w_days, 'earlier_days', t.b_days, 'receivers', t.receivers, 'freq_mhz', t.freq,
          'warn_ppm', v_dw, 'critical_ppm', v_dc)
          || case when t.tx like 'a2:%' then pg_catalog.jsonb_build_object('addr', pg_catalog.substr(t.tx, 4)::integer) else '{}'::jsonb end);
    end if;
  end loop;

  -- ── Signal (0083) ────────────────────────────────────────────────────────
  -- Each base station's view of each transmitter it hears on that
  -- transmitter's own carrier (carrier_snr_links(): each receiver's own
  -- day-to-day shift — everything it hears moving together — taken out), a
  -- link at a time: its last week against the thirty days before, and its
  -- last thirty days against days 61–90. A receiver that came up last week has
  -- no history to judge by and stays out of the change; one whose path to the
  -- station changed is judged on its own and counted apart from the others.
  drop table if exists pg_temp._sl;
  create temporary table _sl on commit drop as select * from meganet.carrier_snr_links(97);

  drop table if exists pg_temp._slk;
  create temporary table _slk on commit drop as
  with k as (
    select l.*, l.day > v_today - 7 as wk, l.day <= v_today - 7 and l.day > v_today - 37 as bk,
           l.day > v_today - 30 as rk, l.day <= v_today - 60 and l.day > v_today - 90 as ok
      from _sl l
  )
  select k.ingest_token_id as tok, k.point_id as pt, k.protocol, k.tx,
         pg_catalog.min(k.station_id) as station_id, pg_catalog.max(k.via) as via,
         pg_catalog.count(*) filter (where k.wk)::integer                                              as w_days,
         coalesce(pg_catalog.sum(k.bursts) filter (where k.wk), 0)::bigint                             as w_n,
         pg_catalog.sum(k.rel_db * k.bursts) filter (where k.wk) / nullif(pg_catalog.sum(k.bursts) filter (where k.wk), 0) as w_rel,
         pg_catalog.sum(k.snr_db * k.bursts) filter (where k.wk) / nullif(pg_catalog.sum(k.bursts) filter (where k.wk), 0) as w_snr,
         pg_catalog.sum(k.var_db * k.bursts) filter (where k.wk) / nullif(pg_catalog.sum(k.bursts) filter (where k.wk), 0) as w_var,
         pg_catalog.count(*) filter (where k.bk)::integer                                              as b_days,
         pg_catalog.sum(k.rel_db * k.bursts) filter (where k.bk) / nullif(pg_catalog.sum(k.bursts) filter (where k.bk), 0) as b_rel,
         pg_catalog.sum(k.snr_db * k.bursts) filter (where k.bk) / nullif(pg_catalog.sum(k.bursts) filter (where k.bk), 0) as b_snr,
         pg_catalog.count(*) filter (where k.rk)::integer                                              as r_days,
         coalesce(pg_catalog.sum(k.bursts) filter (where k.rk), 0)::bigint                             as r_n,
         pg_catalog.sum(k.rel_db * k.bursts) filter (where k.rk) / nullif(pg_catalog.sum(k.bursts) filter (where k.rk), 0) as r_rel,
         pg_catalog.count(*) filter (where k.ok)::integer                                              as o_days,
         pg_catalog.sum(k.rel_db * k.bursts) filter (where k.ok) / nullif(pg_catalog.sum(k.bursts) filter (where k.ok), 0) as o_rel
    from k
   group by 1, 2, 3, 4;

  -- Each transmitter, its links together: a change is judged on a link with 3
  -- days in the last week and 5 in the thirty before (10 and 10 for the three
  -- months), and the transmitter's is the links' weighted by their bursts.
  -- `shift` is what the receivers did themselves over the same days — the
  -- raw change less the transmitter's — said, not counted.
  drop table if exists pg_temp._snr;
  create temporary table _snr on commit drop as
  with k as (
    select x.*, x.w_days >= 3 and x.b_days >= 5 as wj, x.r_days >= 10 and x.o_days >= 10 as sj from _slk x
  )
  select k.tx, pg_catalog.min(k.protocol) as protocol, pg_catalog.min(k.station_id) as station_id, pg_catalog.max(k.via) as via,
         pg_catalog.count(*) filter (where k.w_days > 0)::integer                                       as receivers,
         coalesce(pg_catalog.max(k.w_days), 0)::integer                                                 as w_days,
         coalesce(pg_catalog.sum(k.w_n), 0)::bigint                                                     as w_n,
         pg_catalog.sum(k.w_snr * k.w_n) filter (where k.w_days > 0) / nullif(pg_catalog.sum(k.w_n) filter (where k.w_days > 0), 0) as w_snr,
         pg_catalog.sqrt(pg_catalog.sum(k.w_var * k.w_n) filter (where k.w_days > 0)
           / nullif(pg_catalog.sum(k.w_n) filter (where k.w_days > 0), 0))                              as w_sd,
         pg_catalog.count(*) filter (where k.wj)::integer                                               as judged,
         pg_catalog.sum((k.w_rel - k.b_rel) * k.w_n) filter (where k.wj) / nullif(pg_catalog.sum(k.w_n) filter (where k.wj), 0) as change_db,
         pg_catalog.sum((k.w_snr - k.b_snr) * k.w_n) filter (where k.wj) / nullif(pg_catalog.sum(k.w_n) filter (where k.wj), 0) as raw_db,
         pg_catalog.count(*) filter (where k.wj and k.w_rel - k.b_rel <= -v_sw)::integer               as falling,
         pg_catalog.array_agg(pg_catalog.round((k.w_rel - k.b_rel)::numeric, 1) order by k.w_rel - k.b_rel) filter (where k.wj) as changes,
         pg_catalog.count(*) filter (where k.sj)::integer                                               as s_judged,
         pg_catalog.sum((k.r_rel - k.o_rel) * k.r_n) filter (where k.sj) / nullif(pg_catalog.sum(k.r_n) filter (where k.sj), 0) as season_db,
         pg_catalog.count(*) filter (where k.sj and k.r_rel - k.o_rel <= -v_sw)::integer               as s_falling,
         pg_catalog.array_agg(pg_catalog.round((k.r_rel - k.o_rel)::numeric, 1) order by k.r_rel - k.o_rel) filter (where k.sj) as s_changes
    from k
   group by k.tx;

  -- Its line: each day against the thirty days before last week (its usual),
  -- the receivers' own shifts out — each link against its own usual, then
  -- the links together. A link with no usual yet (a base station new this
  -- month) is left out of the line as it is out of the change, or it would
  -- pull every day it has towards nothing; until one link has five days of
  -- it, the links are drawn against their means over the window.
  drop table if exists pg_temp._snrd;
  create temporary table _snrd on commit drop as
  with lb as (
    select l.ingest_token_id as tok, l.point_id as pt, l.protocol, l.tx,
           pg_catalog.sum(l.rel_db * l.bursts) filter (where l.day <= v_today - 7 and l.day > v_today - 37)
             / nullif(pg_catalog.sum(l.bursts) filter (where l.day <= v_today - 7 and l.day > v_today - 37), 0) as ref,
           pg_catalog.count(*) filter (where l.day <= v_today - 7 and l.day > v_today - 37) as b_days
      from _sl l group by 1, 2, 3, 4
  ), tb as (
    select lb.tx, pg_catalog.bool_or(lb.b_days >= 5) as any_b from lb group by 1
  ), d as (
    select l.tx, l.day,
           pg_catalog.sum((l.rel_db - case when tb.any_b then lb.ref else 0 end) * l.bursts) / pg_catalog.sum(l.bursts) as rel
      from _sl l
      join lb on lb.tok = l.ingest_token_id and lb.pt = l.point_id and lb.protocol = l.protocol and lb.tx = l.tx
      join tb on tb.tx = l.tx
     where lb.b_days >= 5 or not tb.any_b
     group by 1, 2
  )
  select d.tx, pg_catalog.array_agg(d.day order by d.day) as days,
         pg_catalog.array_agg(pg_catalog.round(d.rel::numeric, 2)::real order by d.day) as rel
    from d
   group by d.tx;

  for t in select * from _snr z
            where z.w_days >= 3
              and ((z.judged > 0 and z.change_db <= -v_sw) or (z.s_judged > 0 and z.season_db <= -v_sw)) loop
    -- The worse of the two windows is the one said.
    v_wk := t.judged > 0 and t.change_db <= -v_sw and (t.s_judged = 0 or t.season_db is null or t.change_db <= t.season_db);
    v_drop := case when v_wk then -t.change_db else -t.season_db end;
    v_jn := case when v_wk then t.judged else t.s_judged end;
    v_fn := case when v_wk then t.falling else t.s_falling end;
    v_shift := case when v_wk then t.raw_db - t.change_db end;
    v_sid := case when t.tx like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(t.tx, 4)::integer)
                  when t.tx like 'st:%' then pg_catalog.substr(t.tx, 4) end;
    v_name := (select st.name from meganet.station st where st.id = v_sid);
    v_name := case when t.tx like 'a2:%' then 'ALERT2 ' || pg_catalog.substr(t.tx, 4) || coalesce(' (' || nullif(v_name, '') || ')', '')
                   when t.tx like 'a:%'  then 'ALERT ' || pg_catalog.substr(t.tx, 3)
                   else coalesce(nullif(v_name, ''), pg_catalog.substr(t.tx, 4)) end;
    insert into pg_temp._health_now values (
      'transmitter-snr-falling', t.tx, v_sid, null, null,
      -- Critical when the drop is past the second line and most of the base
      -- stations that judge it saw it: one path alone may be the path.
      case when v_drop >= v_sc and 2 * v_fn > v_jn then 'critical' else 'warn' end,
      v_name || ': SNR down ' || pg_catalog.to_char(v_drop, 'FM9990.0') || ' dB ' || case when v_wk then 'in a week' else 'in three months' end,
      'Heard on its own carrier by ' || t.receivers || ' base station' || case when t.receivers = 1 then '' else 's' end
        || ', at about ' || pg_catalog.to_char(t.w_snr, 'FM9990.0') || ' dB over the receiver''s noise over the last ' || t.w_days || ' days — '
        || case when v_wk then pg_catalog.to_char(v_drop, 'FM9990.0') || ' dB below the thirty days before'
                else 'its last thirty days ' || pg_catalog.to_char(v_drop, 'FM9990.0') || ' dB below the same receivers'' days 61 to 90 ago' end
        || ', once each receiver''s own day-to-day shifts are taken out'
        || case when v_shift is not null and pg_catalog.abs(v_shift) >= 1
                then ' (everything those receivers hear moved ' || pg_catalog.to_char(v_shift, 'FMSG9990.0')
                     || ' dB together over the same days: the receiver, its antenna or the weather, not this station)' else '' end
        || '. '
        || case when v_jn > 1 and v_fn = v_jn then 'All ' || v_jn || ' base stations that hear it directly saw the drop. '
                when v_jn > 1 then 'Only ' || v_fn || ' of the ' || v_jn || ' base stations that hear it directly saw the drop, so it may be that path — something new in the way — rather than the station. '
                else '' end
        || case when v_wk then 'One transmitter weakening on its own is its antenna, cable or connectors — water in the coax, corrosion, an antenna knocked or loosened — or its transmitter''s output power.'
                else 'A slow fall like this is usually water working into the coax or a connector, corrosion, or the antenna itself going.' end,
      pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', t.protocol, 'via', t.via, 'category', 'comms',
        'action', 'Check its antenna, the cable and connectors (water, corrosion, a loose or knocked antenna) and the transmitter''s output power at the next visit — before it fades below what the base stations can decode.',
        'window', case when v_wk then 'week' else 'season' end,
        'drop_db', pg_catalog.round(v_drop::numeric, 1),
        'change_db', pg_catalog.round(t.change_db::numeric, 1), 'season_db', pg_catalog.round(t.season_db::numeric, 1),
        'receivers_shift_db', pg_catalog.round(v_shift::numeric, 1),
        'snr_db', pg_catalog.round(t.w_snr::numeric, 1), 'receivers', t.receivers, 'judged', v_jn, 'falling', v_fn,
        'changes', pg_catalog.to_jsonb(case when v_wk then t.changes else t.s_changes end),
        'days', t.w_days, 'bursts', t.w_n, 'warn_db', v_sw, 'critical_db', v_sc)
        || case when t.tx like 'a2:%' then pg_catalog.jsonb_build_object('addr', pg_catalog.substr(t.tx, 4)::integer) else '{}'::jsonb end);
  end loop;

  -- Each receiver's own shift, day by day — what was taken out above — for
  -- the Base Stations tab (admin_base_station_signal()).
  delete from meganet.receiver_snr_day where true;
  insert into meganet.receiver_snr_day (day, ingest_token_id, point_id, protocol, shift_db, links, bursts, judged_at)
  select l.day, l.ingest_token_id, l.point_id, l.protocol, pg_catalog.min(l.rx_shift_db), pg_catalog.min(l.rx_links),
         pg_catalog.sum(l.bursts)::bigint, p_now
    from _sl l
   group by 1, 2, 3, 4;

  -- ── Who corrupts (0078) ──────────────────────────────────────────────────
  -- Each transmitter's last 7 days: what it sent (its bursts by carrier, the
  -- corrupted ones too) and how much of it was a corrupted copy; how many of
  -- those were clear — as strong as the clean copy, within 6 dB: it sent wrong
  -- bits, not our receiver mishearing a weak one — and how many reached us
  -- clean from upstream as well (the corruption entered at this transmitter:
  -- its own receiver, or itself). Only clear ones make a finding.
  drop table if exists pg_temp._fs;
  create temporary table _fs on commit drop as
  with sent as (
    select c.tx, pg_catalog.min(c.station_id) as sid, pg_catalog.sum(c.n + c.n_out)::bigint as bursts
      from meganet.carrier_daily c
     where c.protocol = 'alert' and c.day > v_today - 7
     group by c.tx
  ), fl as (
    select f.bad_tx as tx, pg_catalog.count(*)::integer as flips,
           -- Clear: as strong as the clean copy, within 6 dB (or not known) — it
           -- was sent wrong; a much weaker one may be this receiver mishearing.
           pg_catalog.count(*) filter (where f.bad_snr is null or f.good_snr is null or f.bad_snr >= f.good_snr - 6)::integer as clear,
           -- The clean version from someone else, and the corrupted one not the
           -- station's own: the corruption entered on the way, here.
           pg_catalog.count(*) filter (where f.good_tx is not null and f.good_tx <> f.bad_tx
                                         and f.bad_tx is distinct from 'st:' || meganet.resolve_station(f.true_addr, null))::integer as clean_upstream,
           pg_catalog.count(*) filter (where f.addr_flip)::integer as addr_flips,
           pg_catalog.count(distinct f.true_addr)::integer as addrs,
           (select pg_catalog.jsonb_agg(z order by z.n desc) from (
              select f2.true_addr as true_addr, f2.bad_addr as bad_addr, pg_catalog.count(*) as n
                from meganet.flip_event f2 where f2.bad_tx = f.bad_tx and f2.day > v_today - 7
               group by 1, 2 order by 3 desc limit 5) z) as top
      from meganet.flip_event f
     where f.day > v_today - 7 and f.bad_tx is not null
     group by f.bad_tx
  )
  select s.tx, s.sid, s.bursts, coalesce(fl.flips, 0) as flips, coalesce(fl.clear, 0) as clear,
         coalesce(fl.clean_upstream, 0) as clean_upstream, coalesce(fl.addr_flips, 0) as addr_flips, coalesce(fl.addrs, 0) as addrs,
         fl.top, coalesce(fl.flips, 0)::double precision / nullif(s.bursts + coalesce(fl.flips, 0), 0) as rate,
         coalesce(fl.clear, 0)::double precision / nullif(s.bursts + coalesce(fl.flips, 0), 0) as clear_rate
    from sent s left join fl on fl.tx = s.tx;

  v_fleet := (select pg_catalog.percentile_cont(0.5) within group (order by z.clear_rate) from _fs z where z.bursts >= 30);
  for t in select * from _fs z where z.clear >= v_fmin and z.clear_rate >= greatest(v_fw, 3 * coalesce(v_fleet, 0)) loop
    v_sid := case when t.tx like 'st:%' then pg_catalog.substr(t.tx, 4) end;
    v_name := (select st.name from meganet.station st where st.id = v_sid);
    v_name := case when t.tx like 'a:%' then 'ALERT ' || pg_catalog.substr(t.tx, 3)
                   else coalesce(nullif(v_name, ''), pg_catalog.substr(t.tx, 4)) end;
    insert into pg_temp._health_now values (
      'transmitter-corrupting', t.tx, v_sid, null, null,
      case when t.clear_rate >= v_fc then 'critical' else 'warn' end,
      v_name || ': ' || t.flips || ' corrupted cop' || case when t.flips = 1 then 'y' else 'ies' end || ' in a week ('
        || pg_catalog.to_char(t.rate * 100, 'FM990.0') || '% of what it sent)',
      'Its own carrier carried ' || t.flips || ' copies of other stations'' readings with one or two bits wrong over the last 7 days, out of '
        || (t.bursts + t.flips) || ' bursts it sent — against ' || pg_catalog.to_char(coalesce(v_fleet, 0) * 100, 'FM990.00')
        || '% for a typical transmitter. ' || t.clear || ' of them arrived as strong as the clean copy, so it sent the wrong bits rather than this receiver mishearing them'
        || case when t.clean_upstream > 0 then '; ' || t.clean_upstream || ' times the clean version reached us from upstream as well, so the corruption entered here' else '' end
        || '. ' || t.addr_flips || ' were wrong in the address — a reading turning up under another station''s number.',
      pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', 'alert', 'category', 'comms',
        'action', 'Look at this transmitter first for the network''s bit flips: its receiver (interference or a weak input at its site), its modem, or its own transmitter. The Bit Flipper shows which addresses it corrupts and into what.',
        'flips', t.flips, 'bursts', t.bursts + t.flips, 'rate', pg_catalog.round(t.rate::numeric, 4), 'clear', t.clear,
        'clear_rate', pg_catalog.round(t.clear_rate::numeric, 4),
        'clean_upstream', t.clean_upstream, 'addr_flips', t.addr_flips, 'addresses', t.addrs, 'top', t.top,
        'fleet_rate', pg_catalog.round(coalesce(v_fleet, 0)::numeric, 4), 'warn_rate', v_fw, 'critical_rate', v_fc));
  end loop;

  delete from meganet.flip_summary where true;
  insert into meganet.flip_summary (tx, station_id, bursts, flips, rate, clear, clear_rate, clean_upstream, addr_flips, addresses, top, fleet_rate, judged_at)
  select z.tx, z.sid, z.bursts + z.flips, z.flips, z.rate, z.clear, z.clear_rate, z.clean_upstream, z.addr_flips, z.addrs, coalesce(z.top, '[]'::jsonb), v_fleet, p_now
    from _fs z;

  -- What the tab draws: every transmitter judged, as judged — its carrier and
  -- (0083) its signal; one heard in the last week with a signal and no
  -- offset to show still gets a row.
  delete from meganet.transmitter_summary where true;
  insert into meganet.transmitter_summary (tx, protocol, station_id, via, freq_mhz, w_days, w_ppm, w_hz, b_days, b_ppm,
                                           change_ppm, bursts, receivers, days, ppm, judged_at,
                                           snr_db, snr_sd, snr_change_db, snr_season_db, snr_receivers, snr_judged, snr_falling,
                                           snr_days, snr_rel)
  select coalesce(z.tx, q.tx), coalesce(z.protocol, q.protocol),
         case when coalesce(z.tx, q.tx) like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(coalesce(z.tx, q.tx), 4)::integer)
              else coalesce(z.station_id, q.station_id) end,
         coalesce(z.via, q.via), z.freq, coalesce(z.w_days, 0), z.w_ppm, z.w_hz, coalesce(z.b_days, 0), z.b_ppm,
         case when z.w_days >= 3 and z.b_days >= 5 then z.w_ppm - z.b_ppm end,
         coalesce(z.w_bursts, 0), coalesce(z.receivers, 0), coalesce(z.days, '{}'::date[]), coalesce(z.ppm, '{}'::real[]), p_now,
         q.w_snr, q.w_sd, q.change_db, q.season_db, coalesce(q.receivers, 0), coalesce(q.judged, 0), coalesce(q.falling, 0),
         coalesce(d.days, '{}'::date[]), coalesce(d.rel, '{}'::real[])
    from _ts z
    full join _snr q on q.tx = z.tx
    left join _snrd d on d.tx = coalesce(z.tx, q.tx)
   where z.tx is not null or q.receivers > 0;

  v_out := meganet.health_apply('transmitters', p_now, true);
  v_took := greatest(0, extract(epoch from pg_catalog.clock_timestamp() - v_started) * 1000)::integer;
  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('transmitters', p_now, v_took, pg_catalog.jsonb_build_object('transmitters', v_judged,
          'signal', (select pg_catalog.count(*) from _snr z where z.receivers > 0)))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', p_now, 'took_ms', v_took, 'judged', v_judged) || v_out;
end;
$$;

comment on function meganet.refresh_transmitter_findings(timestamptz) is
  'Judges every transmitter (0075, 0077, 0078, 0082, 0083): transmitter-off-channel, transmitter-drift, transmitter-corrupting and transmitter-snr-falling findings; transmitter_summary (its carrier and its signal), flip_summary and receiver_snr_day. pg_cron hourly (meganet-transmitter-health). The owner and service_role only.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- create or replace keeps a function's; said again so this file stands on its own.

revoke all on function meganet.carrier_snr_links(integer) from public;
revoke all on function meganet.carrier_snr(integer) from public;
revoke all on function meganet.admin_base_station_signal(bigint) from public;
revoke all on function meganet.roll_up_carriers_day(date) from public;
revoke all on function meganet.refresh_transmitter_findings(timestamptz) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.transmitter_summary to anon, authenticated, service_role;
  grant select, insert, update, delete on meganet.receiver_snr_day to service_role;
  grant execute on function meganet.carrier_snr(integer) to anon, authenticated, service_role;
  grant execute on function meganet.carrier_snr_links(integer) to service_role;
  grant execute on function meganet.admin_base_station_signal(bigint) to authenticated, service_role;
  grant execute on function meganet.roll_up_carriers_day(date) to service_role;
  grant execute on function meganet.refresh_transmitter_findings(timestamptz) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── The days already here, then judged ───────────────────────────────────────
-- Every day whose receptions are still in the database, rebuilt with its SNR
-- (a day whose receptions are released is skipped and keeps what it had —
-- its offsets, without an SNR). Then judged once, as the hourly run will: the
-- run holds the lock while it judges, so wait for one under way first.

select meganet.roll_up_carriers(
  greatest(date '2026-10-19', (pg_catalog.now() at time zone 'UTC')::date - 90),
  (pg_catalog.now() at time zone 'UTC')::date);

do $$
declare
  v jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(5900217);
  v := meganet.refresh_transmitter_findings();
  if v ? 'skipped' then
    raise exception '0083 could not judge the transmitters (%) — apply it again', v ->> 'skipped';
  end if;
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regprocedure('meganet.carrier_snr_links(integer)') is null
     or pg_catalog.to_regprocedure('meganet.carrier_snr(integer)') is null
     or pg_catalog.to_regprocedure('meganet.admin_base_station_signal(bigint)') is null
     or pg_catalog.to_regclass('meganet.receiver_snr_day') is null then
    raise exception '0083 did not take: a function or table is missing';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_constraintdef((select c.oid from pg_catalog.pg_constraint c
       where c.conrelid = 'meganet.health_finding'::regclass and c.conname = 'health_finding_kind')), 'transmitter-snr-falling') = 0 then
    raise exception '0083 did not take: health_finding does not take transmitter-snr-falling';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.roll_up_carriers_day(date)'::regprocedure), 'snr_sumsq') = 0 then
    raise exception '0083 did not take: roll_up_carriers_day() does not keep the SNR';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 83 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '83')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
