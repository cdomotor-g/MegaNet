-- 0088_fewer_writes.sql — The hourly jobs and the reports doing the same work
-- with less: the carrier roll-up's pairs found by range, the reception
-- roll-up putting each detail together once, unchanged station cards left
-- alone, and an ingest token stamped once a minute.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0088_fewer_writes.sql
--
-- Why this file exists
-- ────────────────────
-- 0087 took the largest disk reads and writes out (Supabase's Disk IO Budget
-- warning, 2026-10-28). This is the next layer, each change measured on the
-- live database and each giving the same rows as before:
--
-- **1. roll_up_carriers_day() (hourly).** After 0087 it ran 3 s an hour just
-- after midnight UTC, rising to 13 s by the end of the day and 25 s at 03:11.
-- A full day profiled at 11 s, and three statements held most of it:
--   - pairing a receiver's bursts within five seconds (2.6 s). The join said
--     "within five seconds after" only inside an OR, which no index can use,
--     so each burst scanned its receiver's whole day up to itself — a cost
--     that grew with the square of the day. y.t >= x.t, implied by the OR,
--     said on its own: 26 ms, the same 3,383 pairs;
--   - the day's split bursts counted once per receiver, each count a pass over
--     the day's receptions (1.2 s): now one pass, grouped;
--   - carrier_tx() called up to five times for each corrupted copy (1.7 s):
--     now once for each side of the pair. It is stable, so the answer is the
--     same.
--
-- **2. roll_up_receptions() (hourly).** Every reception's detail was put back
-- together by reception_detail() once for each key read from it — 13 calls
-- in the statement. Once a row: an hour 1.4 s -> 0.18 s, the same groups,
-- counts, minima and maxima; sums of doubles agree to 1e-11, the order they
-- are added in.
--
-- **3. report_station_cards() (every fifteen minutes).** Three cards in four
-- have not changed since the last run, and the upsert's where kept them as
-- they were — but insert ... on conflict locks the row it finds before the
-- where is read, and the lock is a write to the table and the log: 677 MB of
-- WAL in nine days, second only to ingest. An unchanged card is now found and
-- passed over before the upsert; the same counts come back.
--
-- **4. ingest_token_id() (every post).** It stamped the token's last_used_at
-- on every call — about 20,000 updates a day, and autovacuum on the token
-- table every 17 minutes. Now at most once a minute. What reads it shows
-- "last posted 3 min ago" (Base Stations, Admin's tokens).
--
-- Who may run each is unchanged: create or replace keeps their grants.

-- ── 1. roll_up_carriers_day() ────────────────────────────────────────────────

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
      -- y.t >= x.t is implied by the line under it; said on its own it is a
      -- range the index (tok, rx, t) answers, five seconds of a receiver's
      -- bursts rather than its whole day up to x.t (0088: 2.6 s -> 26 ms).
      join _fb y on y.tok = x.tok and y.rx = x.rx and y.t <= x.t + interval '5 seconds' and y.t >= x.t
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
         case when c.bt <> '?' then c.bt end,
         case when b.cfo is null then 'no-carrier'
              when c.bt is null then 'unmatched'
              when c.bt = '?' then 'ambiguous' else 'carrier' end,
         nullif(c.gt, '?')
    from _fp f
    join _fb b on b.id = case when f.bad = 'x' then f.xid else f.yid end
    join _fb g on g.id = case when f.bad = 'x' then f.yid else f.xid end
    -- Each carrier asked once a pair, not five times (0088).
    cross join lateral (
      select case when b.cfo is not null then meganet.carrier_tx(p_day, b.tok, b.rx, g.a, b.cfo) end as bt,
             case when g.cfo is not null then meganet.carrier_tx((g.t at time zone 'UTC')::date, g.tok, g.rx, g.a, g.cfo) end as gt
      offset 0) c
   where f.bad is not null and b.t >= v_t0 and b.t < v_t0 + interval '1 day'
   order by b.id, pg_catalog.abs(extract(epoch from b.t - g.t)), g.id
  on conflict do nothing;

  -- The day's split bursts, counted once for every receiver (0088): a count
  -- each, over the whole day's receptions, was one pass a receiver.
  drop table if exists pg_temp._split;
  create temporary table _split on commit drop as
  select r.ingest_token_id as tok, r.point_id as rx, pg_catalog.count(*) as n
    from meganet.reception r
   where r.heard_at >= v_t0 and r.heard_at < v_t0 + interval '1 day' and r.protocol = 'alert'
     and r.detail ? 'cfo_split'
   group by 1, 2;

  -- What was found, per receiver.
  insert into meganet.carrier_receiver_day (day, ingest_token_id, point_id, detail)
  select p_day, g.tok, g.rx, pg_catalog.jsonb_build_object(
           'bursts', g.n, 'own', g.own, 'repeater', g.rep, 'ambiguous', g.amb, 'unexplained', g.unx,
           'split', coalesce((select s.n from _split s where s.tok = g.tok and s.rx = g.rx), 0),
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
  'Rebuilds one UTC day from its receptions (0077, 0078, 0083): the corrupted copies first (flip_event) — left out of the carriers — then each legacy burst put down to its station or the register repeater whose shared carrier it sits on, ALERT2 to its path''s last address (carrier_daily, with the SNR of the same bursts), then each corrupted copy put down to the transmitter whose carrier it came on. Idempotent; a day whose receptions are gone is skipped. Pairs found by range, split bursts counted in one pass, each carrier asked once (0088). The service key''s.';

-- ── 2. roll_up_receptions() ──────────────────────────────────────────────────

create or replace function meganet.roll_up_receptions(p_max_hours integer default 48)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days_kept integer;
  v_floor     timestamptz;
  v_wm        bigint;
  v_high      bigint;
  v_skipped   integer := 0;
  v_hours     integer := 0;
  v_days      integer := 0;
  v_hour      timestamptz;
  v_day       date;
  v_touched   date[] := '{}';
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to roll up receptions' using errcode = '42501';
  end if;

  v_days_kept := coalesce((select a.value::integer from meganet.app_meta a
                            where a.key = 'retain_reception_days'), 90);
  v_floor := pg_catalog.date_trunc('hour', pg_catalog.now() - v_days_kept * interval '1 day')
             + interval '1 hour';

  -- Note the hours new receptions touched. Only rows received two minutes ago
  -- or more move the watermark: see decision 4.
  v_wm := coalesce((select a.value::bigint from meganet.app_meta a
                     where a.key = 'reception_rollup_watermark'), 0);
  select pg_catalog.max(r.id) into v_high
    from meganet.reception r
   where r.id > v_wm and r.received_at < pg_catalog.now() - interval '2 minutes';

  if v_high is not null then
    insert into meganet.reception_rollup_dirty (bucket)
    select distinct pg_catalog.date_trunc('hour', r.heard_at)
      from meganet.reception r
     where r.id > v_wm and r.id <= v_high
    on conflict (bucket) do nothing;

    insert into meganet.app_meta (key, value)
    values ('reception_rollup_watermark', v_high::text)
    on conflict (key) do update set value = excluded.value;
  end if;

  insert into meganet.reception_rollup_dirty (bucket)
  values (pg_catalog.date_trunc('hour', pg_catalog.now())),
         (pg_catalog.date_trunc('hour', pg_catalog.now()) - interval '1 hour')
  on conflict (bucket) do nothing;

  with gone as (
    delete from meganet.reception_rollup_dirty d where d.bucket < v_floor returning 1
  )
  select pg_catalog.count(*) into v_skipped from gone;

  for v_hour in
    select d.bucket from meganet.reception_rollup_dirty d
     order by d.bucket
     limit greatest(coalesce(p_max_hours, 48), 0)
  loop
    delete from meganet.reception_hourly h where h.bucket = v_hour;

    insert into meganet.reception_hourly (
      bucket, ingest_token_id, point_id, protocol, station, path, survey,
      n, n_ok, n_bad, n_dup,
      n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
      snr_n, snr_min, snr_max, snr_sum,
      nf_dbfs_n, nf_dbfs_min, nf_dbfs_max, nf_dbfs_sum,
      nf_dbm_n, nf_dbm_min, nf_dbm_max, nf_dbm_sum,
      rssi_n, rssi_min, rssi_max, rssi_sum,
      level_n, level_min, level_max, level_sum,
      cfo_n, cfo_min, cfo_max, cfo_sum,
      freq_min, freq_max, first_heard, last_heard, rolled_at)
    select v_hour, x.ingest_token_id, x.point_id, x.protocol, x.station, x.path, x.survey,
           pg_catalog.count(*)::integer,
           (pg_catalog.count(*) filter (where x.ok))::integer,
           (pg_catalog.count(*) filter (where not x.ok))::integer,
           (pg_catalog.count(*) filter (where x.dup))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'rejected'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'undecoded'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'shadow'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'status'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'frame'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'crc'))::integer,
           pg_catalog.count(x.snr)::integer, pg_catalog.min(x.snr), pg_catalog.max(x.snr), pg_catalog.sum(x.snr),
           pg_catalog.count(x.nf_dbfs)::integer, pg_catalog.min(x.nf_dbfs), pg_catalog.max(x.nf_dbfs), pg_catalog.sum(x.nf_dbfs),
           pg_catalog.count(x.nf_dbm)::integer, pg_catalog.min(x.nf_dbm), pg_catalog.max(x.nf_dbm), pg_catalog.sum(x.nf_dbm),
           pg_catalog.count(x.rssi)::integer, pg_catalog.min(x.rssi), pg_catalog.max(x.rssi), pg_catalog.sum(x.rssi),
           pg_catalog.count(x.level)::integer, pg_catalog.min(x.level), pg_catalog.max(x.level), pg_catalog.sum(x.level),
           pg_catalog.count(x.cfo)::integer, pg_catalog.min(x.cfo), pg_catalog.max(x.cfo), pg_catalog.sum(x.cfo),
           pg_catalog.min(x.freq), pg_catalog.max(x.freq),
           pg_catalog.min(x.heard_at), pg_catalog.max(x.heard_at), pg_catalog.now()
      from (
        select r.ingest_token_id, r.point_id, r.protocol,
               case when r.protocol = 'alert2' and (d.d ->> 'source') ~ '^[0-9]{1,9}$'
                    then (d.d ->> 'source')::integer
                    else r.alert_id end                                          as station,
               case when pg_catalog.jsonb_typeof(d.d -> 'path') = 'array'
                    then array(select e::integer
                                 from pg_catalog.jsonb_array_elements_text(d.d -> 'path') e
                                where e ~ '^[0-9]{1,9}$') end                    as path,
               nullif(r.detail ->> 'survey', '')                                 as survey,
               r.ok, r.fault,
               coalesce(d.d -> 'duplicate' = 'true'::jsonb, false)          as dup,
               case when pg_catalog.jsonb_typeof(d.d -> 'snr_db')   = 'number' then (d.d ->> 'snr_db')::double precision   end as snr,
               case when pg_catalog.jsonb_typeof(d.d -> 'nf_dbfs')  = 'number' then (d.d ->> 'nf_dbfs')::double precision  end as nf_dbfs,
               r.nf_dbm::double precision                                        as nf_dbm,
               r.rssi_dbm::double precision                                      as rssi,
               r.level_dbfs::double precision                                    as level,
               case when pg_catalog.jsonb_typeof(d.d -> 'cfo_hz')   = 'number' then (d.d ->> 'cfo_hz')::double precision   end as cfo,
               case when pg_catalog.jsonb_typeof(d.d -> 'freq_mhz') = 'number' then (d.d ->> 'freq_mhz')::double precision end as freq,
               r.heard_at
          from meganet.reception r
          -- The detail put back together once a reception, not once for each
          -- key read from it (0088: an hour 1.4 s -> 0.18 s).
          cross join lateral (select meganet.reception_detail(r) as d offset 0) d
         where r.heard_at >= v_hour and r.heard_at < v_hour + interval '1 hour'
      ) x
     group by x.ingest_token_id, x.point_id, x.protocol, x.station, x.path, x.survey;

    delete from meganet.reception_rollup_dirty d where d.bucket = v_hour;
    v_hours := v_hours + 1;
    v_day := (v_hour at time zone 'UTC')::date;
    if not v_day = any (v_touched) then
      v_touched := v_touched || v_day;
    end if;
  end loop;

  -- The days, from the hours.
  foreach v_day in array v_touched loop
    delete from meganet.reception_daily d where d.bucket = v_day;

    insert into meganet.reception_daily (
      bucket, ingest_token_id, point_id, protocol, station, path, survey,
      n, n_ok, n_bad, n_dup,
      n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
      snr_n, snr_min, snr_max, snr_sum,
      nf_dbfs_n, nf_dbfs_min, nf_dbfs_max, nf_dbfs_sum,
      nf_dbm_n, nf_dbm_min, nf_dbm_max, nf_dbm_sum,
      rssi_n, rssi_min, rssi_max, rssi_sum,
      level_n, level_min, level_max, level_sum,
      cfo_n, cfo_min, cfo_max, cfo_sum,
      freq_min, freq_max, first_heard, last_heard, rolled_at)
    select v_day, h.ingest_token_id, h.point_id, h.protocol, h.station, h.path, h.survey,
           pg_catalog.sum(h.n)::integer, pg_catalog.sum(h.n_ok)::integer, pg_catalog.sum(h.n_bad)::integer, pg_catalog.sum(h.n_dup)::integer,
           pg_catalog.sum(h.n_rejected)::integer, pg_catalog.sum(h.n_undecoded)::integer, pg_catalog.sum(h.n_shadow)::integer,
           pg_catalog.sum(h.n_status)::integer, pg_catalog.sum(h.n_frame)::integer, pg_catalog.sum(h.n_crc)::integer,
           pg_catalog.sum(h.snr_n)::integer, pg_catalog.min(h.snr_min), pg_catalog.max(h.snr_max), pg_catalog.sum(h.snr_sum),
           pg_catalog.sum(h.nf_dbfs_n)::integer, pg_catalog.min(h.nf_dbfs_min), pg_catalog.max(h.nf_dbfs_max), pg_catalog.sum(h.nf_dbfs_sum),
           pg_catalog.sum(h.nf_dbm_n)::integer, pg_catalog.min(h.nf_dbm_min), pg_catalog.max(h.nf_dbm_max), pg_catalog.sum(h.nf_dbm_sum),
           pg_catalog.sum(h.rssi_n)::integer, pg_catalog.min(h.rssi_min), pg_catalog.max(h.rssi_max), pg_catalog.sum(h.rssi_sum),
           pg_catalog.sum(h.level_n)::integer, pg_catalog.min(h.level_min), pg_catalog.max(h.level_max), pg_catalog.sum(h.level_sum),
           pg_catalog.sum(h.cfo_n)::integer, pg_catalog.min(h.cfo_min), pg_catalog.max(h.cfo_max), pg_catalog.sum(h.cfo_sum),
           pg_catalog.min(h.freq_min), pg_catalog.max(h.freq_max),
           pg_catalog.min(h.first_heard), pg_catalog.max(h.last_heard), pg_catalog.now()
      from meganet.reception_hourly h
     where h.bucket >= (v_day::timestamp at time zone 'UTC')
       and h.bucket <  ((v_day + 1)::timestamp at time zone 'UTC')
     group by h.ingest_token_id, h.point_id, h.protocol, h.station, h.path, h.survey;

    v_days := v_days + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'hours',     v_hours,
    'days',      v_days,
    'skipped',   v_skipped,
    'pending',   (select pg_catalog.count(*) from meganet.reception_rollup_dirty),
    'watermark', coalesce(v_high, v_wm));
end;
$$;

comment on function meganet.roll_up_receptions(integer) is
  'Rebuild reception_hourly for up to p_max_hours hours that new receptions touched (oldest first), and reception_daily for their days (0071, #241); each reception''s detail put together once (0088). Idempotent; never touches an hour past retain_reception_days. Returns hours, days, skipped, pending and the watermark. pg_cron hourly (meganet-roll-up-receptions); editors and the service key.';

-- ── 3. report_station_cards() ────────────────────────────────────────────────

create or replace function meganet.report_station_cards(p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at        timestamptz;
  v_last      timestamptz;
  v_days      smallint;
  v_complete  boolean;
  v_detail    jsonb;
  v_heard     text[];
  c           jsonb;
  v_i         integer := 0;
  v_up        integer := 0;
  v_same      integer := 0;
  v_removed   integer := 0;
  v_n         integer;
begin
  if p_report is null or pg_catalog.jsonb_typeof(p_report) <> 'object' then
    raise exception 'report_station_cards takes an object' using errcode = '22023';
  end if;
  begin
    v_at := (p_report ->> 'at')::timestamptz;
  exception when others then
    raise exception 'at is not a time: %', pg_catalog.left(p_report ->> 'at', 40) using errcode = '22023';
  end;
  if v_at is null or v_at > pg_catalog.now() + interval '5 minutes' or v_at < pg_catalog.now() - interval '1 day' then
    raise exception 'at must be within the last day, not %', coalesce(v_at::text, 'missing') using errcode = '22023';
  end if;
  if coalesce(p_report ->> 'days', '') not in ('3', '7', '14') then
    raise exception 'days is 3, 7 or 14, not %', coalesce(pg_catalog.left(p_report ->> 'days', 20), 'missing') using errcode = '22023';
  end if;
  v_days := (p_report ->> 'days')::smallint;
  if pg_catalog.jsonb_typeof(p_report -> 'cards') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_report -> 'cards') > 500 then
    raise exception 'cards is a list of at most 500 — send a run''s cards in batches' using errcode = '22023';
  end if;
  v_complete := coalesce((p_report -> 'complete') = 'true'::jsonb, false);
  if v_complete and (pg_catalog.jsonb_typeof(p_report -> 'heard') is distinct from 'array'
                     or pg_catalog.jsonb_array_length(p_report -> 'heard') > 20000
                     or exists (select 1 from pg_catalog.jsonb_array_elements(p_report -> 'heard') h
                                 where pg_catalog.jsonb_typeof(h) <> 'string')) then
    raise exception 'a complete report names every station it heard: heard is a list of at most 20,000 ids' using errcode = '22023';
  end if;
  v_detail := coalesce(nullif(p_report -> 'detail', 'null'::jsonb), '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_detail) <> 'object' or pg_catalog.octet_length(v_detail::text) > 4096 then
    raise exception 'detail is an object of at most 4 KB' using errcode = '22023';
  end if;

  -- One batch at a time, and never one from an older run over a newer.
  perform pg_catalog.pg_advisory_xact_lock(8500085);
  select r.at into v_last from meganet.health_card_run r where r.days = v_days;
  if v_last is not null and v_at < v_last then
    return pg_catalog.jsonb_build_object('stale', true, 'at', v_at, 'days', v_days, 'last', v_last);
  end if;

  for c in select * from pg_catalog.jsonb_array_elements(p_report -> 'cards') loop
    v_i := v_i + 1;
    if pg_catalog.jsonb_typeof(c) <> 'object'
       or pg_catalog.length(coalesce(c ->> 'station_id', '')) not between 1 and 200
       or (c ? 'status' and c -> 'status' <> 'null'::jsonb and coalesce(c ->> 'status', '') not in ('critical', 'warn', 'info', 'ok', 'irregular'))
       or (c ? 'worst' and c -> 'worst' <> 'null'::jsonb and coalesce(c ->> 'worst', '') not in ('critical', 'warn', 'info'))
       or pg_catalog.jsonb_typeof(c -> 'findings') is distinct from 'number'
       or pg_catalog.jsonb_typeof(c -> 'attention') is distinct from 'number'
       or pg_catalog.jsonb_typeof(c -> 'card') is distinct from 'object'
       or pg_catalog.octet_length((c -> 'card')::text) > 32768 then
      raise exception 'card % is not one: it needs a station_id, a status and worst severity or null, finding counts, and a card object of at most 32 KB', v_i
        using errcode = '22023';
    end if;
    -- A card that has not changed is left alone before the upsert, not by
    -- its where: an insert ... on conflict locks the row it finds, and the
    -- lock is a write too — three in four cards, every fifteen minutes (0088).
    if exists (select 1 from meganet.health_card hc
                where hc.days = v_days and hc.station_id = c ->> 'station_id'
                  and hc.card is not distinct from c -> 'card'
                  and hc.status is not distinct from nullif(c ->> 'status', '')
                  and hc.worst is not distinct from nullif(c ->> 'worst', '')) then
      v_same := v_same + 1;
      continue;
    end if;
    insert into meganet.health_card as hc (days, station_id, status, worst, findings, attention, card, changed_at)
    values (v_days, c ->> 'station_id', nullif(c ->> 'status', ''), nullif(c ->> 'worst', ''),
            (c ->> 'findings')::numeric::integer, (c ->> 'attention')::numeric::integer, c -> 'card', v_at)
    on conflict (days, station_id) do update set
      status = excluded.status, worst = excluded.worst, findings = excluded.findings,
      attention = excluded.attention, card = excluded.card, changed_at = excluded.changed_at
    where hc.card is distinct from excluded.card
       or hc.status is distinct from excluded.status
       or hc.worst is distinct from excluded.worst;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_up := v_up + 1; else v_same := v_same + 1; end if;
  end loop;

  if v_complete then
    select pg_catalog.array_agg(h) into v_heard
      from pg_catalog.jsonb_array_elements_text(p_report -> 'heard') h;
    delete from meganet.health_card hc
     where hc.days = v_days and hc.station_id <> all (coalesce(v_heard, '{}'::text[]));
    get diagnostics v_removed = row_count;
  end if;

  -- A later batch of the same run adds to what the first said about it.
  insert into meganet.health_card_run as r (days, at, detail)
  values (v_days, v_at, v_detail || pg_catalog.jsonb_build_object('complete', v_complete))
  on conflict (days) do update set at = excluded.at,
    detail = case when r.at = excluded.at then r.detail || excluded.detail else excluded.detail end;

  return pg_catalog.jsonb_build_object('at', v_at, 'days', v_days, 'complete', v_complete,
           'upserted', v_up, 'unchanged', v_same, 'removed', v_removed);
end;
$$;

comment on function meganet.report_station_cards(jsonb) is
  'What health-analysis.js worked out about each station heard over one of Station Health''s windows, reported a batch at a time by .github/workflows/station-health.yml (0085): upserts the cards that changed — an unchanged card is not touched at all (0088) — removes those of stations a complete run no longer heard, refuses a batch from a run older than the last accepted. The secret key only.';

-- ── 4. ingest_token_id() ─────────────────────────────────────────────────────

create or replace function meganet.ingest_token_id()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_headers   jsonb;
  v_token_txt text;
  v_hash      text;
  v_id        bigint;
  v_revoked   timestamptz;
begin
  v_headers   := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  v_token_txt := nullif(pg_catalog.btrim(coalesce(v_headers ->> 'x-ingest-token', '')), '');

  if v_token_txt is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'see docs/ingest-mqtt.md for how the bridge authenticates';
  end if;

  v_hash := pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(v_token_txt, 'utf8')), 'hex');

  select t.id, t.revoked_at into v_id, v_revoked
    from meganet.ingest_token t where t.token_hash = v_hash;

  if v_id is null or v_revoked is not null then
    raise exception 'invalid or revoked ingest token'
      using errcode = 'PT401',
            hint    = 'see docs/ingest-mqtt.md';
  end if;

  -- Same as ingest_http(): stamped before what follows is judged. One honest
  -- caveat (#102): the stamp rides the request's own transaction, so a request
  -- that errors after this point rolls the stamp back with it — last_used_at
  -- records the last *successful* use, which is still the answer "has this
  -- credential stopped being used" needs, just with failed attempts invisible.
  -- At most once a minute (0088): every post stamped it, ~20,000 a day, each
  -- an update and a dead row; what reads it says "last posted 3 min ago".
  update meganet.ingest_token set last_used_at = pg_catalog.now()
   where id = v_id and (last_used_at is null or last_used_at < pg_catalog.now() - interval '1 minute');

  return v_id;
end;
$$;

comment on function meganet.ingest_token_id() is
  'Check the X-Ingest-Token header against meganet.ingest_token and return its id, or raise PT401; last_used_at stamped at most once a minute (0088). The token check 0007 does inline, factored out for 0008''s endpoints.';

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  f := pg_catalog.pg_get_functiondef('meganet.roll_up_carriers_day(date)'::regprocedure);
  if pg_catalog.strpos(f, 'and y.t >= x.t') = 0 or pg_catalog.strpos(f, 'pg_temp._split') = 0
     or pg_catalog.strpos(f, 'end as bt,') = 0 then
    raise exception '0088 did not take: roll_up_carriers_day() is the old one';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.roll_up_receptions(integer)'::regprocedure),
                       'select meganet.reception_detail(r) as d offset 0') = 0 then
    raise exception '0088 did not take: roll_up_receptions() still puts the detail together for each key';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.report_station_cards(jsonb)'::regprocedure),
                       'hc.card is not distinct from c -> ''card''') = 0 then
    raise exception '0088 did not take: report_station_cards() still upserts unchanged cards';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.ingest_token_id()'::regprocedure),
                       'last_used_at < pg_catalog.now() - interval ''1 minute''') = 0 then
    raise exception '0088 did not take: ingest_token_id() still stamps every call';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live.

insert into meganet.app_meta (key, value)
values ('schema_version', '88')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
