-- 0092_repeater_heard.sql — What each repeater is heard relaying, and how
-- long it takes to do it, kept by the hourly carrier roll-up so the Repeaters
-- tab reads a row a repeater instead of a week of receptions.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0092_repeater_heard.sql
--
-- Why this file exists
-- ────────────────────
-- 🔁 Repeaters (repeaters.js) sets each repeater's pass ranges on record
-- beside the addresses the base stations hear it relaying. That came from
-- Signal Routes, which reads a week of legacy receptions into the browser
-- (about 65,000 rows, sixty-odd pages, a minute) and runs 0077's attribution
-- again there — every time anybody opens either tab. The server already does
-- that attribution every hour, burst by burst, in roll_up_carriers_day(), and
-- keeps only counts (carrier_daily). So it now keeps the answer too:
--
--   meganet.relay_daily      a day, a repeater, an address, a kind:
--                              relayed     an address it passes, on its carrier;
--                              off_record  on its carrier, an address it does
--                                          not pass (with its copies, and every
--                                          burst of the address at the
--                                          receivers that found its carrier);
--                              elsewhere   an address it passes, heard where its
--                                          carrier was found that day, not on it.
--   meganet.relay_gap_daily  a day, a repeater: every gap from a station's own
--                            burst to the repeater's copy of it (same address,
--                            same value, same receiver, within 5 s). The
--                            receiver's clock is the same for both, so it is
--                            the repeater's turnaround — its delay, its
--                            transmitter coming up and the 133 ms frame —
--                            measured. On the live receptions (30 Oct) about
--                            300 such pairs a day, 0.5 s to 3 s apart.
--   meganet.relay_summary    a row a repeater: the last seven days of both,
--                            as arrays, rebuilt at the end of every
--                            roll_up_carriers(). Public, like
--                            transmitter_summary: it names no receiver.
--
-- The cost: a few thousand small rows a day, rewritten with their day as
-- carrier_daily is (today, and yesterday until 03:00 UTC), and a hundred-odd
-- summary rows an hour. Against that, the tab's one request of ~150 rows.
--
-- On apply, roll_up_carriers() runs over the last seven days, so the summary
-- holds a week at once; those days' carrier_daily and flip_event rows are
-- rebuilt from the same receptions as they would be on any hourly run.

-- ── The tables ───────────────────────────────────────────────────────────────

create table if not exists meganet.relay_daily (
  day         date    not null,
  station_id  text    not null,
  alert_id    integer not null,
  kind        text    not null check (kind in ('relayed', 'off_record', 'elsewhere')),
  n           integer not null check (n >= 0),
  n_dup       integer not null default 0,
  n_all       integer not null default 0,
  receivers   integer not null default 1,
  primary key (day, station_id, alert_id, kind)
);
comment on table meganet.relay_daily is
  'A UTC day of what each register repeater was heard relaying, across every receiver (0092): relayed (an address it passes, on its carrier), off_record (on its carrier, not an address it passes; n_dup its copies, n_all every burst of the address at the receivers that found its carrier), elsewhere (an address it passes, heard where its carrier was found, not on it). Rebuilt with its day by roll_up_carriers_day(); 90 days kept. The service key''s.';

create table if not exists meganet.relay_gap_daily (
  day         date    not null,
  station_id  text    not null,
  n           integer not null,
  gaps_ms     real[]  not null,
  primary key (day, station_id)
);
comment on table meganet.relay_gap_daily is
  'A UTC day of the gaps from a station''s own burst to a repeater''s copy of it at one receiver — the same address and value, within 5 s — in ms, sorted (0092): the repeater''s turnaround, its delay among it. Rebuilt with its day by roll_up_carriers_day(); 90 days kept. The service key''s.';

create table if not exists meganet.relay_summary (
  station_id   text        primary key,
  days         integer     not null,
  first_day    date,
  last_day     date,
  bursts       bigint      not null,
  relayed      integer[]   not null,
  relayed_n    integer[]   not null,
  off_record   integer[]   not null,
  off_dup      integer[]   not null,
  off_own      integer[]   not null,
  off_all      integer[]   not null,
  elsewhere    integer[]   not null,
  gap_n        integer     not null default 0,
  gap_days     integer     not null default 0,
  gap_ms       real,
  gap_lo_ms    real,
  gap_hi_ms    real,
  window_from  date        not null,
  window_days  integer     not null,
  judged_at    timestamptz not null
);
comment on table meganet.relay_summary is
  'A row a repeater (0092): over the last window_days UTC days, the addresses it was heard relaying on its carrier (relayed, with bursts each), those on its carrier it does not pass (off_record, with copies, own-looking bursts and every burst at the receivers that found it), those it passes but was heard only another way (elsewhere), the days its carrier was found, and its turnaround measured from a station''s burst to its copy (median, quartiles, how many). Rebuilt by roll_up_carriers(). Public: no receiver is named.';

alter table meganet.relay_daily enable row level security;
alter table meganet.relay_gap_daily enable row level security;
alter table meganet.relay_summary enable row level security;
drop policy if exists relay_summary_read_all on meganet.relay_summary;
create policy relay_summary_read_all on meganet.relay_summary for select using (true);

-- ── The week, a row a repeater ───────────────────────────────────────────────

create or replace function meganet.refresh_relay_summary(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'UTC')::date;
  v_from  date := v_today - (greatest(1, p_days) - 1);
  v_n     integer;
begin
  delete from meganet.relay_daily where day < v_today - 90;
  delete from meganet.relay_gap_daily where day < v_today - 90;

  delete from meganet.relay_summary where true;
  insert into meganet.relay_summary (station_id, days, first_day, last_day, bursts, relayed, relayed_n,
                                     off_record, off_dup, off_own, off_all, elsewhere,
                                     gap_n, gap_days, gap_ms, gap_lo_ms, gap_hi_ms, window_from, window_days, judged_at)
  with d as (
    select * from meganet.relay_daily where day >= v_from
  ), rel as (
    select d.station_id, d.alert_id, pg_catalog.sum(d.n)::integer as n from d where d.kind = 'relayed' group by 1, 2
  ), off as (
    select d.station_id, d.alert_id, pg_catalog.sum(d.n_dup)::integer as dup, pg_catalog.sum(d.n - d.n_dup)::integer as own,
           pg_catalog.sum(d.n_all)::integer as al
      from d where d.kind = 'off_record' group by 1, 2
  ), els as (
    select distinct d.station_id, d.alert_id from d where d.kind = 'elsewhere'
    except
    select rel.station_id, rel.alert_id from rel
  ), found as (
    select d.station_id, pg_catalog.count(distinct d.day)::integer as days, pg_catalog.min(d.day) as first_day,
           pg_catalog.max(d.day) as last_day, pg_catalog.sum(d.n)::bigint as bursts
      from d where d.kind = 'relayed' group by 1
  ), gaps as (
    select g.station_id, pg_catalog.count(*)::integer as n, pg_catalog.count(distinct g.day)::integer as days,
           pg_catalog.percentile_cont(0.5) within group (order by u.x) as med,
           pg_catalog.percentile_cont(0.25) within group (order by u.x) as lo,
           pg_catalog.percentile_cont(0.75) within group (order by u.x) as hi
      from meganet.relay_gap_daily g cross join lateral pg_catalog.unnest(g.gaps_ms) u(x)
     where g.day >= v_from
     group by 1
  ), ids as (
    select station_id from found union select station_id from off union select station_id from els union select station_id from gaps
  )
  select i.station_id, coalesce(f.days, 0), f.first_day, f.last_day, coalesce(f.bursts, 0),
         coalesce((select pg_catalog.array_agg(r.alert_id order by r.alert_id) from rel r where r.station_id = i.station_id), '{}'),
         coalesce((select pg_catalog.array_agg(r.n order by r.alert_id) from rel r where r.station_id = i.station_id), '{}'),
         coalesce((select pg_catalog.array_agg(o.alert_id order by o.alert_id) from off o where o.station_id = i.station_id), '{}'),
         coalesce((select pg_catalog.array_agg(o.dup order by o.alert_id) from off o where o.station_id = i.station_id), '{}'),
         coalesce((select pg_catalog.array_agg(o.own order by o.alert_id) from off o where o.station_id = i.station_id), '{}'),
         coalesce((select pg_catalog.array_agg(o.al order by o.alert_id) from off o where o.station_id = i.station_id), '{}'),
         coalesce((select pg_catalog.array_agg(e.alert_id order by e.alert_id) from els e where e.station_id = i.station_id), '{}'),
         coalesce(g.n, 0), coalesce(g.days, 0), g.med::real, g.lo::real, g.hi::real, v_from, greatest(1, p_days), pg_catalog.now()
    from ids i
    left join found f on f.station_id = i.station_id
    left join gaps g on g.station_id = i.station_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function meganet.refresh_relay_summary(integer) is
  'Rebuilds relay_summary from the last p_days (7) UTC days of relay_daily and relay_gap_daily, and drops their days older than 90 (0092). Run at the end of every roll_up_carriers(). The service key''s.';

-- ── roll_up_carriers_day(): 0089's, keeping what each repeater relayed ───────

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
      -- bursts rather than its whole day up to x.t (0089: 2.6 s -> 26 ms).
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
         r.snr_db::double precision as snr,
         r.heard_at as t, r.value_raw as v   -- the gap from a station's burst to a repeater's copy (0092)
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
  select b.id, b.t, b.v, b.dup, b.tok, b.rx, b.a, b.cfo, b.f, b.snr,
         case when cl.k = 1 then 'repeater'
              when cl.k > 1 then 'ambiguous'
              when b.dup then 'unexplained'
              else 'own' end as how,
         case when cl.k = 1 then 'st:' || cl.rid
              when cl.k is null and not b.dup then coalesce('st:' || meganet.resolve_station(b.a, null), 'a:' || b.a)
         end as tx
    from _cb b left join claim cl on cl.id = b.id;


  -- ── What each repeater was heard relaying (0092) ───────────────────────────
  -- Kept a day at a time, across every receiver (none is named), for the
  -- Repeaters tab's "pass ranges as heard" — what Signal Routes worked out in
  -- the browser from a week of receptions:
  --   relayed     an address it passes, heard on its carrier;
  --   off_record  heard on its carrier, but an address it does not pass — its
  --               copies (n_dup), its own-looking bursts, and every burst of
  --               that address at the receivers that found its carrier (n_all),
  --               which the tab weighs as Signal Routes does;
  --   elsewhere   an address it passes, heard at a receiver that found its
  --               carrier that day, but not on it.
  delete from meganet.relay_daily where day = p_day;
  delete from meganet.relay_gap_daily where day = p_day;

  insert into meganet.relay_daily (day, station_id, alert_id, kind, n, n_dup, n_all, receivers)
  select p_day, pg_catalog.substr(s.tx, 4), s.a, 'relayed', pg_catalog.count(*)::integer,
         pg_catalog.count(*) filter (where s.dup)::integer, 0,
         pg_catalog.count(distinct (s.tok, s.rx))::integer
    from _as s
    join _rp rp on rp.rid = pg_catalog.substr(s.tx, 4)
   where s.how = 'repeater'
     and not (s.a = any (rp.own))                  -- its own sensors, sent on its own carrier: not relays
   group by 2, 3;

  insert into meganet.relay_daily (day, station_id, alert_id, kind, n, n_dup, n_all, receivers)
  with o as (
    select r.rid, s.a, s.tok, s.rx, s.dup
      from _as s
      join _rep r on r.tok = s.tok and r.rx = s.rx and pg_catalog.abs(s.cfo - r.centre) <= c_tol
     where s.how in ('own', 'unexplained')
       and not exists (select 1 from _cand c where c.id = s.id and c.rid = r.rid)
  ), g as (
    select o.rid, o.a, pg_catalog.count(*)::integer as n, pg_catalog.count(*) filter (where o.dup)::integer as n_dup,
           pg_catalog.count(distinct (o.tok, o.rx))::integer as receivers
      from o group by 1, 2
  )
  select p_day, g.rid, g.a, 'off_record', g.n, g.n_dup,
         (select pg_catalog.count(*)::integer from _cb b
           where b.a = g.a and exists (select 1 from _rep r where r.rid = g.rid and r.tok = b.tok and r.rx = b.rx)),
         g.receivers
    from g;

  insert into meganet.relay_daily (day, station_id, alert_id, kind, n, n_dup, n_all, receivers)
  select p_day, c.rid, c.a, 'elsewhere', pg_catalog.count(*)::integer, pg_catalog.count(*) filter (where s.dup)::integer, 0,
         pg_catalog.count(distinct (c.tok, c.rx))::integer
    from _cand c
    join _rep r on r.tok = c.tok and r.rx = c.rx and r.rid = c.rid
    join _rp rp on rp.rid = c.rid
    join _as s on s.id = c.id
   where not (c.a = any (rp.own))
     and s.how <> 'ambiguous'                      -- on two carriers, one of them perhaps its own: no word either way
     and s.tx is distinct from 'st:' || c.rid
   group by 2, 3;

  -- The gap from a station's own burst to a repeater's copy of it, at one
  -- receiver: the same address and value, on the station's carrier and then
  -- on the repeater's, within five seconds. The receiver's clock is the same
  -- for both, so the gap is the repeater's turnaround — its delay, its
  -- transmitter coming up and the frame — whatever that clock says.
  create index on _as (tok, rx, a, v, t);
  insert into meganet.relay_gap_daily (day, station_id, n, gaps_ms)
  select p_day, z.rid, pg_catalog.count(*)::integer, pg_catalog.array_agg(z.gap order by z.gap)
    from (select distinct on (y.id) pg_catalog.substr(y.tx, 4) as rid,
                 (extract(epoch from y.t - x.t) * 1000)::real as gap
            from _as y
            join _as x on x.tok = y.tok and x.rx = y.rx and x.a = y.a and x.v = y.v
                      and x.t < y.t and x.t >= y.t - interval '5 seconds'
                      and x.how = 'own'
           where y.how = 'repeater' and y.v is not null
           order by y.id, x.t desc) z
   where z.gap >= 50
   group by z.rid;

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
    -- Each carrier asked once a pair, not five times (0089).
    cross join lateral (
      select case when b.cfo is not null then meganet.carrier_tx(p_day, b.tok, b.rx, g.a, b.cfo) end as bt,
             case when g.cfo is not null then meganet.carrier_tx((g.t at time zone 'UTC')::date, g.tok, g.rx, g.a, g.cfo) end as gt
      offset 0) c
   where f.bad is not null and b.t >= v_t0 and b.t < v_t0 + interval '1 day'
   order by b.id, pg_catalog.abs(extract(epoch from b.t - g.t)), g.id
  on conflict do nothing;

  -- The day's split bursts, counted once for every receiver (0089): a count
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
           'relay_rows', (select pg_catalog.count(*) from meganet.relay_daily rd where rd.day = p_day),
           'rows', (select pg_catalog.count(*) from meganet.carrier_daily where day = p_day))
    into v_out;
  return v_out;
end;
$$;

comment on function meganet.roll_up_carriers_day(date) is
  'Rebuilds one UTC day from its receptions (0077, 0078, 0083): the corrupted copies first (flip_event) — left out of the carriers — then each legacy burst put down to its station or the register repeater whose shared carrier it sits on, ALERT2 to its path''s last address (carrier_daily, with the SNR of the same bursts), then each corrupted copy put down to the transmitter whose carrier it came on. Idempotent; a day whose receptions are gone is skipped. Pairs found by range, split bursts counted in one pass, each carrier asked once (0089). And what each repeater was heard relaying, and the gap from a station''s burst to its copy (relay_daily, relay_gap_daily; 0092). The service key''s.';


-- ── roll_up_carriers(): 0087's, the summary rebuilt at its end ──────────────

create or replace function meganet.roll_up_carriers(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now  timestamp := pg_catalog.now() at time zone 'UTC';
  v_to   date := coalesce(p_to, v_now::date);
  -- No dates: today; yesterday too until 03:00 UTC (no reception has come in
  -- later than that after its day); the day before as well at 03:xx, once a
  -- day, for a receiver that was cut off (0087). An end date alone: the three
  -- days to it, as before.
  v_from date := coalesce(p_from, v_to - case when p_to is not null then 2
                                              when pg_catalog.date_part('hour', v_now) < 3 then 1
                                              when pg_catalog.date_part('hour', v_now) < 4 then 2
                                              else 0 end);
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
  -- The week each repeater was heard relaying, for the Repeaters tab (0092).
  return pg_catalog.jsonb_build_object('days', v_out, 'relay_summary', meganet.refresh_relay_summary());
end;
$$;

comment on function meganet.roll_up_carriers(date, date) is
  'roll_up_carriers_day() for each day from p_from to p_to, then refresh_relay_summary() (0092). With no dates (0087): today; yesterday too before 03:00 UTC; the day before as well from 03:00 to 03:59 UTC. A day whose receptions are gone is skipped, never emptied. pg_cron hourly (meganet-roll-up-carriers). The service key''s.';

-- ── Grants ───────────────────────────────────────────────────────────────────

revoke all on function meganet.refresh_relay_summary(integer) from public;
revoke all on function meganet.roll_up_carriers_day(date) from public;
revoke all on function meganet.roll_up_carriers(date, date) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  revoke insert, update, delete, truncate on meganet.relay_summary from anon, authenticated;
  revoke all on meganet.relay_daily, meganet.relay_gap_daily from anon, authenticated;
  grant select on meganet.relay_summary to anon, authenticated, service_role;
  grant select, insert, update, delete on meganet.relay_daily, meganet.relay_gap_daily, meganet.relay_summary to service_role;
  grant execute on function meganet.refresh_relay_summary(integer) to service_role;
  grant execute on function meganet.roll_up_carriers_day(date) to service_role;
  grant execute on function meganet.roll_up_carriers(date, date) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── A week at once ───────────────────────────────────────────────────────────
-- The last seven days rolled up again, so relay_summary holds a week from the
-- start rather than filling over the next one. A day whose receptions are
-- gone is skipped, as on any run; a run already under way (pg_cron) makes
-- this one step aside, and the next hourly run fills what it can.

select meganet.roll_up_carriers((pg_catalog.now() at time zone 'UTC')::date - 6, (pg_catalog.now() at time zone 'UTC')::date);

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.relay_daily') is null
     or pg_catalog.to_regclass('meganet.relay_gap_daily') is null
     or pg_catalog.to_regclass('meganet.relay_summary') is null
     or pg_catalog.to_regprocedure('meganet.refresh_relay_summary(integer)') is null
     or pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.roll_up_carriers_day(date)'::regprocedure), 'relay_daily') = 0
     or pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.roll_up_carriers(date,date)'::regprocedure), 'refresh_relay_summary') = 0 then
    raise exception '0092 did not take: a table or function is missing, or the roll-up does not keep what it relayed';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes to 92 once this is applied (CLAUDE.md).
-- Guarded, so applying this late can never lower the number (db/README.md).

insert into meganet.app_meta (key, value)
values ('schema_version', '92')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
