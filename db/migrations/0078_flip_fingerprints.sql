-- 0078_flip_fingerprints.sql — Who corrupts: each bit-flipped copy put down to
-- the transmitter that sent it, by its carrier (#217's fingerprints, for the
-- 151.5 MHz bit flips).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0078_flip_fingerprints.sql
--
-- After 0077.
--
-- Why this file exists
-- ────────────────────
-- Station Health and the Reception Map already find corrupted copies —
-- readings one or two bits from a real one, a moment after it — and blame
-- repeaters for them by pass range alone, the blame split evenly between
-- every repeater that could have carried the reading (health-analysis.js
-- repeater-bitflips, reception.js). A legacy burst does not say who sent it,
-- so that is all they could do. Its carrier does say (0077): every burst
-- arrives on the carrier of the transmitter that put it on the air, and RPi
-- ALERT 0.14 measures it. So a corrupted copy can be charged to the one
-- transmitter whose carrier it came on.
--
-- On the live receptions, 2026-10-18 to 21: pairs of bursts on one receiver
-- within five seconds, one bit apart, are as common as four bits apart though
-- there are 443 times fewer ways to be one bit apart — they are corruption,
-- not chance — about 140 a day at one or two bits, a median 1.7 s apart, 60%
-- of them in the address. Which of a pair is the corrupted one is decided by
-- the first rule that can (roll_up_carriers_day below): not a flip when one
-- station carries both addresses with two values, or both values fit one
-- address's series; else the one on no station; the one on a station not
-- otherwise heard for a week; the one that does not fit its address's last reading; the one
-- heard fewer times; else undecided. On those three days: 247 decided, 83
-- undecided, 73 not flips (with a two-day 'silent' and the sensors rule
-- before its values were asked). A burst judged corrupted in one pair and
-- true in another sets aside every pair it is in (`unsure`). A low-bit value
-- flip on a slow series looks like two real reports and is not counted; a
-- counter wrapping past 2047 can fool `fit`.
--
-- What is kept. meganet.flip_event — a row per corrupted copy: the true and
-- corrupted address and value, the bits, which rule decided, the two bursts'
-- SNR and carriers, and the transmitter whose carrier each came on (`bad_tx`,
-- `good_tx`; `bad_how` carrier | unmatched | no-carrier). Kept forever, the
-- service key's (it names receivers). A corrupted copy is left out of 0077's
-- carrier attribution, where it would have counted under the wrong address.
--
-- Judged hourly with the drift findings (refresh_transmitter_findings): each
-- transmitter's last 7 days — bursts sent, corrupted copies sent, how many
-- clear (as strong as the clean copy, within 6 dB: the transmitter sent wrong
-- bits; one much weaker may be the receiver mishearing it — most bursts here
-- arrive at 5–15 dB, so no fixed level would do), how many also reached us
-- clean from upstream (the corruption entered at this transmitter).
-- `transmitter-corrupting` (source transmitters): 5 or more clear in a week
-- and a clear rate of 2% and three times the typical transmitter's; critical
-- at 10% (app_meta tx_flip_min,
-- tx_flip_warn_rate, tx_flip_crit_rate). meganet.flip_summary (public) a row
-- a transmitter; meganet.recent_flips() (public) the events, no receiver named;
-- meganet.flip_overview() (public) how many were found and decided.
--
-- It narrows; it does not convict. A repeater whose own receiver hears
-- interference passes on what it heard — the corruption entered at its site,
-- which is where to look, but its own radio may be fine.

insert into meganet.app_meta (key, value) values
  ('tx_flip_min', '5'), ('tx_flip_warn_rate', '0.02'), ('tx_flip_crit_rate', '0.10')
on conflict (key) do nothing;

alter table meganet.health_finding drop constraint if exists health_finding_kind;
alter table meganet.health_finding add constraint health_finding_kind
  check (kind ~ '^[a-z][a-z0-9-]{1,39}$'
         and (source = 'stations'
              or (source = 'base-stations' and kind in ('base-station-quiet', 'receiver-deaf'))
              or (source = 'transmitters' and kind in ('transmitter-off-channel', 'transmitter-drift', 'transmitter-corrupting'))));

create table if not exists meganet.flip_event (
  id                 bigserial    primary key,
  day                date         not null,
  ingest_token_id    bigint       not null,
  point_id           text         not null,
  heard_at           timestamptz  not null,
  true_addr          integer      not null,
  true_value         integer      not null,
  bad_addr           integer      not null,
  bad_value          integer      not null,
  bits               integer      not null check (bits between 1 and 24),
  addr_flip          boolean      not null,
  gap_s              real         not null,
  rule               text         not null check (rule in ('ghost', 'silent-address', 'fit', 'copies')),
  bad_reception_id   bigint       not null,
  good_reception_id  bigint       not null,
  bad_snr            real,
  good_snr           real,
  bad_cfo            real,
  good_cfo           real,
  bad_copy           boolean      not null default false,
  bad_tx             text,
  bad_how            text         not null check (bad_how in ('carrier', 'unmatched', 'ambiguous', 'no-carrier')),
  good_tx            text,
  unique (bad_reception_id, good_reception_id)
);
comment on table meganet.flip_event is
  'A corrupted copy (0078): a legacy burst one or two bits from a real one heard by the same receiver within five seconds — the true and corrupted address and value, the rule that decided which was which, both bursts'' SNR and carrier, and the transmitter whose carrier each came on (bad_tx, good_tx). Kept forever. The service key''s: it names receivers.';
create index if not exists flip_event_day_idx on meganet.flip_event (day);
create index if not exists flip_event_tx_idx on meganet.flip_event (bad_tx, day);
create index if not exists flip_event_addr_idx on meganet.flip_event (true_addr, day);
create index if not exists flip_event_bad_addr_idx on meganet.flip_event (bad_addr, day);

create table if not exists meganet.flip_summary (
  tx              text             primary key,
  station_id      text,
  bursts          bigint           not null,
  flips           integer          not null,
  rate            double precision,
  clear           integer          not null,
  clear_rate      double precision,
  clean_upstream  integer          not null,
  addr_flips      integer          not null,
  addresses       integer          not null,
  top             jsonb            not null default '[]'::jsonb,
  fleet_rate      double precision,
  judged_at       timestamptz      not null
);
alter table meganet.flip_summary drop column if exists loud;
alter table meganet.flip_summary add column if not exists clear integer not null default 0;
alter table meganet.flip_summary add column if not exists clear_rate double precision;
comment on table meganet.flip_summary is
  'Each legacy transmitter''s last 7 days of corrupted copies (0078), as refresh_transmitter_findings() last judged them: bursts it sent, corrupted copies among them, how many as strong as the clean copy (clear), how many also reached us clean from upstream, the commonest true → corrupted address pairs. Public: no receiver is named.';

alter table meganet.flip_event enable row level security;
alter table meganet.flip_summary enable row level security;
drop policy if exists flip_summary_read_all on meganet.flip_summary;
create policy flip_summary_read_all on meganet.flip_summary for select using (true);

-- ── The transmitter a burst came from, by its carrier ────────────────────────

create or replace function meganet.carrier_tx(p_day date, p_tok bigint, p_rx text, p_addr integer, p_cfo double precision,
                                              p_tol double precision default 40)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- Of the transmitters that could have sent address p_addr — its station,
  -- the repeaters that pass it, a repeater whose own sensor it is — the one
  -- this receiver heard that day with a carrier nearest p_cfo, within p_tol Hz.
  -- '?' when two of them are within 15 Hz of each other's distance: the
  -- carrier does not say which.
  with c as (
  select c.tx, pg_catalog.abs(c.cfo_sum / nullif(c.n, 0) - p_cfo) as d
    from meganet.carrier_daily c
   where p_cfo is not null and c.day = p_day and c.ingest_token_id = p_tok and c.point_id = p_rx and c.protocol = 'alert'
     and not c.mixed and c.n >= 3 and pg_catalog.abs(c.cfo_sum / nullif(c.n, 0) - p_cfo) <= p_tol
     and (c.tx = 'st:' || meganet.resolve_station(p_addr, null) or c.tx = 'a:' || p_addr
          or c.station_id in (select p.repeater_id from meganet.pass_range p
                                join meganet.station s on s.id = p.repeater_id and s.deleted_at is null
                               where p.kind = 'pass' and p_addr between p.lo and p.hi
                                 and not exists (select 1 from meganet.pass_range e where e.repeater_id = p.repeater_id
                                                  and e.kind = 'exclusion' and p_addr between e.lo and e.hi))
          or c.station_id in (select se.station_id from meganet.sensor se
                                join meganet.repeater rp on rp.station_id = se.station_id where se.alert_id = p_addr))
  ), r as (
    select c.tx, c.d, pg_catalog.lead(c.d) over (order by c.d, c.tx) as next_d from c
  )
  select case when r.next_d is not null and r.next_d - r.d < 15 then '?' else r.tx end
    from r order by r.d, r.tx limit 1;
$$;

comment on function meganet.carrier_tx(date, bigint, text, integer, double precision, double precision) is
  'The transmitter whose carrier a burst came on (0078): of address p_addr''s station and the repeaters that pass it, the one receiver p_rx heard on p_day nearest p_cfo, within p_tol Hz (carrier_daily). Null when none is; ''?'' when two are within 15 Hz of each other''s distance.';

-- ── Rolling a day up, flips first (restated from 0077) ───────────────────────

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

  -- The day's legacy bursts with an offset.
  drop table if exists pg_temp._cb;
  create temporary table _cb on commit drop as
  select r.id, r.ingest_token_id as tok, r.point_id as rx, r.alert_id as a,
         coalesce(r.a2_duplicate, false) as dup, r.cfo_hz::double precision as cfo, r.freq_mhz as f
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
  'Rebuilds one UTC day from its receptions (0077, 0078): the corrupted copies first (flip_event) — left out of the carriers — then each legacy burst put down to its station or the register repeater whose shared carrier it sits on, ALERT2 to its path''s last address (carrier_daily), then each corrupted copy put down to the transmitter whose carrier it came on. Idempotent; a day whose receptions are gone is skipped. The service key''s.';

-- ── The findings, with who corrupts (restated from 0077) ─────────────────────

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
  'Judges every transmitter (0075, 0077, 0078): transmitter-off-channel, transmitter-drift and transmitter-corrupting findings, transmitter_summary and flip_summary for the Station Health tab. pg_cron hourly (meganet-transmitter-health). The owner and service_role only.';

-- ── Reading the events, no receiver named ────────────────────────────────────

drop function if exists meganet.recent_flips(integer, integer, text);
create or replace function meganet.recent_flips(p_days integer default 7, p_addr integer default null, p_tx text default null)
returns table (heard_at timestamptz, true_addr integer, true_value integer, bad_addr integer, bad_value integer, bits integer,
               addr_flip boolean, gap_s real, rule text, bad_snr real, good_snr real, bad_tx text, bad_how text, good_tx text,
               good_measured boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select f.heard_at, f.true_addr, f.true_value, f.bad_addr, f.bad_value, f.bits, f.addr_flip, f.gap_s, f.rule,
         f.bad_snr, f.good_snr, f.bad_tx, f.bad_how, f.good_tx, f.good_cfo is not null
    from meganet.flip_event f
   where f.day > (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 7), 1), 400)
     and (p_addr is null or f.true_addr = p_addr or f.bad_addr = p_addr)
     and (p_tx is null or f.bad_tx = p_tx)
   order by f.heard_at desc
   limit 1000;
$$;

comment on function meganet.recent_flips(integer, integer, text) is
  'The corrupted copies of the last p_days (0078), newest first, at most 1000 — optionally those of one address (true or corrupted) or sent by one transmitter. Public: no receiver is named.';

create or replace function meganet.flip_overview(p_days integer default 7)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 7), 1), 400),
    'corrupted', (select pg_catalog.count(*) from meganet.flip_event f
                   where f.day > (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 7), 1), 400)),
    'by_how', coalesce((select pg_catalog.jsonb_object_agg(z.bad_how, z.n) from (
                 select f.bad_how, pg_catalog.count(*) as n from meganet.flip_event f
                  where f.day > (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 7), 1), 400) group by 1) z), '{}'::jsonb),
    'by_rule', coalesce((select pg_catalog.jsonb_object_agg(z.rule, z.n) from (
                 select f.rule, pg_catalog.count(*) as n from meganet.flip_event f
                  where f.day > (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 7), 1), 400) group by 1) z), '{}'::jsonb),
    'undecided', coalesce((select pg_catalog.sum(((d.detail -> 'flips' ->> 'ambiguous'))::integer) from meganet.carrier_receiver_day d
                 where d.day > (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 7), 1), 400)), 0),
    'weak', (select pg_catalog.count(*) from meganet.flip_event f where f.bad_snr < f.good_snr - 6
              and f.day > (pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 7), 1), 400)));
$$;

comment on function meganet.flip_overview(integer) is
  'How many corrupted copies the last p_days held (0078): decided, by rule, by how their sender was found (carrier, unmatched, no-carrier), loud, and how many pairs stayed undecided. Public.';

-- ── Grants ───────────────────────────────────────────────────────────────────

revoke all on function meganet.carrier_tx(date, bigint, text, integer, double precision, double precision) from public;
revoke all on function meganet.roll_up_carriers_day(date) from public;
revoke all on function meganet.refresh_transmitter_findings(timestamptz) from public;
revoke all on function meganet.recent_flips(integer, integer, text) from public;
revoke all on function meganet.flip_overview(integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.flip_summary to anon, authenticated, service_role;
  grant select, insert, update, delete on meganet.flip_event to service_role;
  grant usage, select on sequence meganet.flip_event_id_seq to service_role;
  grant execute on function meganet.recent_flips(integer, integer, text) to anon, authenticated, service_role;
  grant execute on function meganet.flip_overview(integer) to anon, authenticated, service_role;
  grant execute on function meganet.carrier_tx(date, bigint, text, integer, double precision, double precision) to service_role;
  grant execute on function meganet.roll_up_carriers_day(date) to service_role;
  grant execute on function meganet.refresh_transmitter_findings(timestamptz) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── The days already here ────────────────────────────────────────────────────
-- The last fortnight again, with its flips — quick enough for the SQL editor.
-- Receptions are kept 90 days; the rest of them, when wanted, one statement:
--   select meganet.roll_up_carriers(current_date - 89, current_date - 15);

do $$
begin
  perform meganet.roll_up_carriers((pg_catalog.now() at time zone 'UTC')::date - 14, (pg_catalog.now() at time zone 'UTC')::date);
  perform meganet.refresh_transmitter_findings();
end
$$;

do $$
begin
  if pg_catalog.to_regclass('meganet.flip_event') is null
     or pg_catalog.to_regprocedure('meganet.recent_flips(integer,integer,text)') is null then
    raise exception '0078 did not take: a table or function is missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 78 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '78')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
