-- 0077_legacy_carrier_drift.sql — Transmitter drift for legacy ALERT too: each
-- burst's carrier put down to the transmitter that sent it — the station, or
-- the repeater that relayed it — and kept by the day, for good (#217).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0077_legacy_carrier_drift.sql
--
-- After 0075 (and 0076, which another change took first).
--
-- Why this file exists
-- ────────────────────
-- 0075 measured ALERT2 transmitters only: a legacy ALERT reception arrived with
-- no carrier offset. RPi ALERT 0.14 sends one (`cfo_hz`) for every legacy
-- burst its SDR decodes — measured only when the burst was one steady carrier
-- (a repeater keying up as its station lets go holds the squelch open across
-- both, and their average is neither; such a burst comes with `cfo_split`
-- instead) — and it now keeps a repeater's copy of a reading, as a reception
-- marked `duplicate`, where its decoder used to drop it as a repeat. Most of the
-- network is legacy, so this is where drift matters.
--
-- A legacy burst does not say who sent it. ALERT2 carries its path; ALERT does
-- not, and on the channels the base station hears, repeaters transmit on the
-- frequency they receive on (151.500 MHz: 68 repeaters, both ways), so the
-- channel does not say either. Put a relayed burst down to its station and the
-- station takes on the repeater's carrier — and the repeater's drift shows on
-- every station behind it. So each burst is put down to its transmitter first,
-- by what the register knows and what the carriers show:
--
-- **1. A repeater's carrier is shared.** Everything it relays goes out on its
-- one carrier. For each repeater in the register, take that receiver's day of
-- bursts from the addresses it passes (meganet.pass_range, less exclusions)
-- and from its own sensors (meganet.sensor.alert_id), and find the ±30 Hz window
-- holding the most distinct addresses. It is the repeater's carrier when
--   * its own sensors were heard there — and no other repeater passes them, or
--     they would as well be that other repeater relaying its sensors (91 of the
--     104 repeaters with sensors have one inside another's pass range); such
--     sensors count only as addresses it passes; or
--   * at least 4 of the addresses it passes were, and at least half of those
--     the receiver heard from its pass range that day.
-- Stations' own carriers are spread over hundreds of hertz, so a 60 Hz window
-- holds about a tenth of them by chance: half is far past chance.
--
-- **2. Two repeaters on one carrier** (centres within 60 Hz) are one
-- transmitter. When one passes the other's sensors, the carrier is the one
-- that relays — the other was heard through it — and only it is kept; when
-- neither does, only one heard on its own sensors is kept; otherwise neither,
-- for the day. So no burst sits on two kept repeaters' carriers (`ambiguous`
-- is kept below as a guard, and should stay zero).
--
-- **3. Each burst then goes to:**
--   * the repeater, when it sits within 30 Hz of a kept repeater's carrier and
--     its address is that repeater's to pass (or its own);
--   * nobody, when it is a copy (`duplicate`) and no repeater claims it — a
--     relay the register does not explain; counted, set aside;
--   * otherwise its own station (resolve_station(); an address shared by two
--     stations stays `a:<address>`). A station whose own carrier happens to sit
--     within 30 Hz of its repeater's is put down to the repeater — about one in
--     ten by the arithmetic above — and so is not measured; never the reverse.
--
-- **4. A transmitter's day must be one carrier.** A day's bursts more than
-- 60 Hz from their median (bursts agree to ~±20 Hz) are another transmitter
-- under the same name — a repeater the register does not have, a pass range
-- that is wrong. Two or more of them, and a tenth of the day or more: the day
-- is kept, marked `mixed`, and not measured; so is a day whose bursts spread
-- wider than 35 Hz (two carriers too close for the median to part, ~70 Hz
-- apart half and half). Fewer strays (a click, one stray) are left out of its
-- sums, and counted (`n_out`). ALERT2 the same way.
--
-- What is kept. meganet.carrier_daily: a row per receiver, day and
-- transmitter — bursts, the sum and sum of squares of their offsets, how many
-- addresses, whether own or by repeater, mixed or not — forever (a few thousand
-- rows a day), long after the receptions behind it have aged out at 90 days.
-- ALERT2 goes into it too (the path's last address, as 0075), so both kinds
-- are measured one way — each against its own kind's fleet on that receiver,
-- since the two are measured by different decoders (carrier.js, alert2-air.js)
-- and a bias between them must not move either. meganet.carrier_receiver_day says
-- for each receiver's day what was found: repeaters and where, how many bursts
-- went where, how many were split, ambiguous or unexplained. Both are the
-- service key's: they name receivers.
--
-- meganet.carrier_offsets() is 0075's model over carrier_daily: each
-- receiver's daily error taken out (the median of its transmitters' moves that
-- day), each transmitter against the median of the fleet that receiver hears.
-- refresh_transmitter_findings() now judges every transmitter — `a2:<address>`,
-- `st:<station id>`, `a:<address>` — keeps the judgement in
-- meganet.transmitter_summary (public: one row a transmitter, its last week,
-- its change, its days; no receiver named) for the Station Health tab, and
-- writes the same findings as 0075. transmitter_offsets() stays, the ALERT2
-- part of carrier_offsets(), for what reads it.
--
-- pg_cron: meganet-roll-up-carriers hourly at minute 11 (the last three UTC
-- days, for a base station's spool arriving late), after the reception
-- rollups (minute 9); the transmitter findings at minute 13, as 0075. A day is
-- never rebuilt once its receptions are gone (released by retain(), or none
-- left): what carrier_daily holds for it is all there will ever be.

-- ── The tables ───────────────────────────────────────────────────────────────

create table if not exists meganet.carrier_daily (
  day              date             not null,
  ingest_token_id  bigint           not null,
  point_id         text             not null,
  tx               text             not null check (tx ~ '^(a2|st|a):.+$'),
  protocol         text             not null check (protocol in ('alert', 'alert2')),
  station_id       text,
  via              text             not null check (via in ('own', 'repeater', 'path')),
  n                integer          not null,
  cfo_sum          double precision not null,
  cfo_sumsq        double precision not null,
  ids              integer          not null default 1,
  mixed            boolean          not null default false,
  n_out            integer          not null default 0,
  freq_mhz         double precision,
  rolled_at        timestamptz      not null default pg_catalog.now(),
  primary key (day, ingest_token_id, point_id, tx)
);
comment on table meganet.carrier_daily is
  'Each receiver''s day of each transmitter''s carrier offsets (0077, #217): bursts, sum and sum of squares of cfo_hz — legacy ALERT put down to its station or the repeater that relayed it, ALERT2 to its path''s last address. Kept forever. mixed: the day''s bursts were more than one carrier, not measured; n_out: strays more than 60 Hz from the day''s median, left out of the sums. The service key''s.';
alter table meganet.carrier_daily add column if not exists n_out integer not null default 0;
alter table meganet.carrier_daily drop constraint if exists carrier_daily_n_check;
alter table meganet.carrier_daily drop constraint if exists carrier_daily_n;
alter table meganet.carrier_daily add constraint carrier_daily_n check (n >= 0 and n_out >= 0 and n + n_out > 0);
create index if not exists carrier_daily_tx_idx on meganet.carrier_daily (tx, day);

create table if not exists meganet.carrier_receiver_day (
  day              date        not null,
  ingest_token_id  bigint      not null,
  point_id         text        not null,
  detail           jsonb       not null,
  rolled_at        timestamptz not null default pg_catalog.now(),
  primary key (day, ingest_token_id, point_id)
);
comment on table meganet.carrier_receiver_day is
  'What roll_up_carriers() found in each receiver''s day of legacy bursts (0077): the repeaters whose carriers it found and where, and how many bursts went to stations, to repeaters, were ambiguous, unexplained copies or split. The service key''s.';

create table if not exists meganet.transmitter_summary (
  tx           text             primary key,
  protocol     text             not null,
  station_id   text,
  via          text,
  freq_mhz     double precision,
  w_days       integer          not null,
  w_ppm        double precision,
  w_hz         double precision,
  b_days       integer          not null,
  b_ppm        double precision,
  change_ppm   double precision,
  bursts       bigint           not null,
  receivers    integer          not null,
  days         date[]           not null,
  ppm          real[]           not null,
  judged_at    timestamptz      not null
);
comment on table meganet.transmitter_summary is
  'One row a transmitter (0077): its offset against the fleet over the last 7 days, the 30 before, the change, and its daily ppm for the Station Health tab''s line — what refresh_transmitter_findings() judged. Public: no receiver is named.';

alter table meganet.carrier_daily enable row level security;
alter table meganet.carrier_receiver_day enable row level security;
alter table meganet.transmitter_summary enable row level security;
drop policy if exists transmitter_summary_read_all on meganet.transmitter_summary;
create policy transmitter_summary_read_all on meganet.transmitter_summary for select using (true);

-- ── Rolling a day up ─────────────────────────────────────────────────────────

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

  -- The day's legacy bursts with an offset.
  drop table if exists pg_temp._cb;
  create temporary table _cb on commit drop as
  select r.id, r.ingest_token_id as tok, r.point_id as rx, r.alert_id as a,
         coalesce(r.a2_duplicate, false) as dup, r.cfo_hz::double precision as cfo, r.freq_mhz as f
    from meganet.reception r
   where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day'
     and r.protocol = 'alert' and r.ok and r.alert_id is not null and r.cfo_hz is not null
     and r.ingest_token_id is not null;

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
  select b.tok, b.rx, b.a, b.cfo, b.f,
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
  select s.tok, s.rx, s.tx, 'alert'::text as protocol, s.how, s.a, s.cfo, s.f
    from _as s where s.tx is not null
  union all
  select q.tok, q.rx, 'a2:' || q.a, 'alert2', 'path', q.a, q.cfo, q.f
    from (select r.ingest_token_id as tok, r.point_id as rx,
                 coalesce(r.a2_path[pg_catalog.array_length(r.a2_path, 1)], r.a2_source) as a,
                 r.cfo_hz::double precision as cfo, r.freq_mhz as f
            from meganet.reception r
           where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day'
             and r.protocol = 'alert2' and r.cfo_hz is not null and r.ingest_token_id is not null) q
   where q.a is not null;

  -- A day a transmitter: strays from its median left out, and a day with too
  -- many of them — another carrier under its name — marked mixed.
  insert into meganet.carrier_daily (day, ingest_token_id, point_id, tx, protocol, station_id, via, n, cfo_sum, cfo_sumsq, ids, mixed, n_out, freq_mhz)
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
         pg_catalog.max(y.f)
    from y
   group by y.tok, y.rx, y.tx;

  -- What was found, per receiver.
  insert into meganet.carrier_receiver_day (day, ingest_token_id, point_id, detail)
  select p_day, g.tok, g.rx, pg_catalog.jsonb_build_object(
           'bursts', g.n, 'own', g.own, 'repeater', g.rep, 'ambiguous', g.amb, 'unexplained', g.unx,
           'split', (select pg_catalog.count(*) from meganet.reception r
                      where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day' and r.protocol = 'alert'
                        and r.ingest_token_id = g.tok and r.point_id = g.rx and r.detail ? 'cfo_split'),
           'repeaters', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'station_id', r.rid, 'centre_hz', pg_catalog.round(r.centre::numeric), 'addresses', r.ids,
                'own_addresses', r.own_ids, 'passes_heard', r.nids) order by r.rid)
              from _rep r where r.tok = g.tok and r.rx = g.rx), '[]'::jsonb))
    from (select s.tok, s.rx, pg_catalog.count(*) as n,
                 pg_catalog.count(*) filter (where s.how = 'own') as own,
                 pg_catalog.count(*) filter (where s.how = 'repeater') as rep,
                 pg_catalog.count(*) filter (where s.how = 'ambiguous') as amb,
                 pg_catalog.count(*) filter (where s.how = 'unexplained') as unx
            from _as s group by 1, 2) g;

  select pg_catalog.jsonb_build_object('day', p_day,
           'legacy_bursts', (select pg_catalog.count(*) from _cb),
           'repeaters_found', (select pg_catalog.count(*) from _rep),
           'rows', (select pg_catalog.count(*) from meganet.carrier_daily where day = p_day))
    into v_out;
  return v_out;
end;
$$;

comment on function meganet.roll_up_carriers_day(date) is
  'Rebuilds carrier_daily and carrier_receiver_day for one UTC day from its receptions (0077, #217): each legacy ALERT burst put down to its station, or to the register repeater whose shared carrier it sits on and whose address it passes; ALERT2 to its path''s last address. Idempotent. The service key''s.';

create or replace function meganet.roll_up_carriers(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to   date := coalesce(p_to, (pg_catalog.now() at time zone 'UTC')::date);
  v_from date := coalesce(p_from, v_to - 2);
  d      date;
  v_out  jsonb := '[]'::jsonb;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(5900218) then
    return pg_catalog.jsonb_build_object('skipped', 'another run is under way');
  end if;
  d := v_from;
  while d <= v_to loop
    v_out := v_out || pg_catalog.jsonb_build_array(meganet.roll_up_carriers_day(d));
    d := d + 1;
  end loop;
  return pg_catalog.jsonb_build_object('days', v_out);
end;
$$;

comment on function meganet.roll_up_carriers(date, date) is
  'roll_up_carriers_day() for each day from p_from to p_to (default the last three UTC days); a day whose receptions are gone is skipped, never emptied. pg_cron hourly (meganet-roll-up-carriers). The service key''s.';

-- ── The daily series, both kinds ─────────────────────────────────────────────

create or replace function meganet.carrier_offsets(p_days integer default 37)
returns table (tx text, protocol text, station_id text, via text, day date,
               offset_hz double precision, offset_ppm double precision,
               bursts bigint, receivers integer, freq_mhz double precision)
language sql
stable
security definer
set search_path = ''
as $$
  -- 0075's model, over carrier_daily: cfo = the transmitter's own offset +
  -- the receiver's error that day + noise.
  with t as (
    -- A receiver's day of a transmitter, its own kind's fleet its company: the
    -- receiver key is (token, point, protocol). 20 bursts a day for ALERT2, as
    -- 0075; 3 for legacy, a station reporting every few hours.
    select c.day as d, c.ingest_token_id as tok, c.point_id || '|' || c.protocol as rx, c.tx as a,
           c.protocol, c.station_id, c.via, c.n::bigint as n, c.cfo_sum / c.n as cfo, c.freq_mhz as f
      from meganet.carrier_daily c
     where not c.mixed and c.n >= case when c.protocol = 'alert2' then 20 else 3 end
       and c.day >= (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 37), 1), 400)
  ), m0 as (
    select t.tok, t.rx, t.a, pg_catalog.sum(t.cfo * t.n) / pg_catalog.sum(t.n) as m from t group by 1, 2, 3
  ), e as (
    select t.tok, t.rx, t.d, pg_catalog.percentile_cont(0.5) within group (order by t.cfo - m0.m) as e, pg_catalog.count(*) as k
      from t join m0 on m0.tok = t.tok and m0.rx = t.rx and m0.a = t.a
     group by 1, 2, 3
  ), m1 as (
    select t.tok, t.rx, t.a, pg_catalog.sum((t.cfo - e.e) * t.n) / pg_catalog.sum(t.n) as m
      from t join e on e.tok = t.tok and e.rx = t.rx and e.d = t.d
     where e.k >= 2 group by 1, 2, 3
  ), fl as (
    select m1.tok, m1.rx, pg_catalog.percentile_cont(0.5) within group (order by m1.m) as med, pg_catalog.count(*) as ntx
      from m1 group by 1, 2
  ), rel as (
    select t.a, t.protocol, t.station_id, t.via, t.d, t.n, t.f, t.cfo - e.e - fl.med as off
      from t
      join e  on e.tok = t.tok and e.rx = t.rx and e.d = t.d
      join fl on fl.tok = t.tok and fl.rx = t.rx
     where e.k >= 2 and fl.ntx >= 3
  )
  select r.a, pg_catalog.min(r.protocol), pg_catalog.min(r.station_id), pg_catalog.max(r.via), r.d,
         pg_catalog.sum(r.off * r.n) / pg_catalog.sum(r.n),
         pg_catalog.sum(r.off * r.n) / pg_catalog.sum(r.n) / nullif(pg_catalog.max(r.f), 0),
         pg_catalog.sum(r.n)::bigint, pg_catalog.count(*)::integer, pg_catalog.max(r.f)
    from rel r
   group by r.a, r.d
   order by r.a, r.d;
$$;

comment on function meganet.carrier_offsets(integer) is
  'Each transmitter''s carrier offset by UTC day over the last p_days (0077, #217) — legacy ALERT stations and repeaters (st:<station>, a:<address>) and ALERT2 (a2:<address>) — with each receiver''s daily error taken out, against the median of the fleet of its own kind that receiver hears, in Hz and ppm, combined across receivers by bursts. From carrier_daily, mixed days left out; at most 400 days. Public: no receiver is named.';

-- 0075's function, now the ALERT2 part of the one above.
create or replace function meganet.transmitter_offsets(p_days integer default 37)
returns table (addr integer, day date, offset_hz double precision, offset_ppm double precision,
               bursts bigint, receivers integer, freq_mhz double precision)
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.substr(o.tx, 4)::integer, o.day, o.offset_hz, o.offset_ppm, o.bursts, o.receivers, o.freq_mhz
    from meganet.carrier_offsets(p_days) o
   where o.protocol = 'alert2'
   order by 1, 2;
$$;

comment on function meganet.transmitter_offsets(integer) is
  'The ALERT2 part of carrier_offsets() (0075, restated 0077): each ALERT2 transmitter''s daily offset against the fleet. Public.';

-- ── The findings, every transmitter ──────────────────────────────────────────

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
        v_name || ': transmitting ' || pg_catalog.to_char(t.w_ppm, 'SG0.0') || ' ppm off the others ('
          || pg_catalog.to_char(t.w_hz, 'SG9990') || ' Hz)',
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
        v_name || ': drifted ' || pg_catalog.to_char(t.w_ppm - t.b_ppm, 'SG0.0') || ' ppm in a week',
        'Its carrier offset against the other transmitters was ' || pg_catalog.to_char(t.b_ppm, 'SG0.00') || ' ppm over the '
          || t.b_days || ' days before last week, and ' || pg_catalog.to_char(t.w_ppm, 'SG0.00') || ' ppm over the last '
          || t.w_days || '. A crystal moving this fast is ageing or failing, or the site is running hot or cold; it tends to end in silence.',
        pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', t.protocol, 'via', t.via, 'category', 'comms',
          'action', 'Its crystal is moving: check the frequency soon, and the site''s temperature and power — before it goes quiet.',
          'recent_ppm', pg_catalog.round(t.w_ppm::numeric, 2), 'earlier_ppm', pg_catalog.round(t.b_ppm::numeric, 2),
          'recent_days', t.w_days, 'earlier_days', t.b_days, 'receivers', t.receivers, 'freq_mhz', t.freq,
          'warn_ppm', v_dw, 'critical_ppm', v_dc)
          || case when t.tx like 'a2:%' then pg_catalog.jsonb_build_object('addr', pg_catalog.substr(t.tx, 4)::integer) else '{}'::jsonb end);
    end if;
  end loop;

  -- What the tab draws: every transmitter judged, as judged.
  delete from meganet.transmitter_summary where true;
  insert into meganet.transmitter_summary (tx, protocol, station_id, via, freq_mhz, w_days, w_ppm, w_hz, b_days, b_ppm,
                                           change_ppm, bursts, receivers, days, ppm, judged_at)
  select z.tx, z.protocol,
         case when z.tx like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(z.tx, 4)::integer) else z.station_id end,
         z.via, z.freq, z.w_days, z.w_ppm, z.w_hz, z.b_days, z.b_ppm,
         case when z.w_days >= 3 and z.b_days >= 5 then z.w_ppm - z.b_ppm end,
         z.w_bursts, z.receivers, z.days, z.ppm, p_now
    from _ts z;

  v_out := meganet.health_apply('transmitters', p_now, true);
  v_took := greatest(0, extract(epoch from pg_catalog.clock_timestamp() - v_started) * 1000)::integer;
  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('transmitters', p_now, v_took, pg_catalog.jsonb_build_object('transmitters', v_judged))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', p_now, 'took_ms', v_took, 'judged', v_judged) || v_out;
end;
$$;

comment on function meganet.refresh_transmitter_findings(timestamptz) is
  'Judges every transmitter in carrier_offsets() (0075, restated 0077): transmitter-off-channel and transmitter-drift findings (subject a2:<address>, st:<station>, a:<address>), and transmitter_summary for the Station Health tab. pg_cron hourly (meganet-transmitter-health). The owner and service_role only.';

-- ── Grants ───────────────────────────────────────────────────────────────────

revoke all on function meganet.roll_up_carriers_day(date) from public;
revoke all on function meganet.roll_up_carriers(date, date) from public;
revoke all on function meganet.carrier_offsets(integer) from public;
revoke all on function meganet.transmitter_offsets(integer) from public;
revoke all on function meganet.refresh_transmitter_findings(timestamptz) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.transmitter_summary to anon, authenticated, service_role;
  grant select, insert, update, delete on meganet.carrier_daily, meganet.carrier_receiver_day to service_role;
  grant execute on function meganet.carrier_offsets(integer) to anon, authenticated, service_role;
  grant execute on function meganet.transmitter_offsets(integer) to anon, authenticated, service_role;
  grant execute on function meganet.roll_up_carriers_day(date) to service_role;
  grant execute on function meganet.roll_up_carriers(date, date) to service_role;
  grant execute on function meganet.refresh_transmitter_findings(timestamptz) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── The days already here, and hourly from now ───────────────────────────────
-- Carrier offsets began on 2026-10-19 (ALERT2); legacy ones arrive with RPi
-- ALERT 0.14. Receptions are kept 90 days, so this is everything there is.

select meganet.roll_up_carriers(
  greatest(date '2026-10-19', (pg_catalog.now() at time zone 'UTC')::date - 90),
  (pg_catalog.now() at time zone 'UTC')::date);
select meganet.refresh_transmitter_findings();

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.roll_up_carriers() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-roll-up-carriers', '11 * * * *', 'select meganet.roll_up_carriers()');
    raise notice 'meganet.roll_up_carriers() runs hourly at minute 11 (pg_cron job meganet-roll-up-carriers).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): carrier offsets will not be rolled up until it is.', sqlerrm;
  end;
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regprocedure('meganet.roll_up_carriers(date,date)') is null
     or pg_catalog.to_regprocedure('meganet.carrier_offsets(integer)') is null
     or pg_catalog.to_regclass('meganet.transmitter_summary') is null then
    raise exception '0077 did not take: a function or table is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 77 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '77')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
