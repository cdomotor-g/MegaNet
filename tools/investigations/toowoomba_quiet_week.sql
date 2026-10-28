-- Investigation 02 — Toowoomba's quiet week. The four exports in
-- data/investigations/2026-10-toowoomba-quiet-week/, each query returning one
-- cell of CSV text: paste it into the file named above the query.
--
-- Read-only, and run as a role that can read meganet.flip_event and
-- meganet.reception (the service key's and editors'; neither is public). No
-- export names a receiver, a base station or a token: every row is a channel,
-- a time, an address or a carrier offset. Times are Brisbane (UTC+10).
--
-- Legacy ALERT only (protocol 'alert'). Toowoomba's channel is 151.525 MHz;
-- 151.500 MHz, the only other channel Flood-Net's receiver heard throughout
-- and one Toowoomba doesn't use, is the comparison. The receiver's other
-- channels changed during the fortnight (152.400 dropped on 24 October,
-- 151.575 added on 22 October), so they are left out rather than compared
-- across the change.
--
-- An address is in group toowoomba when Toowoomba AL's pass ranges in
-- stations.json hold it (4000–4099, 6526–6527, and its own gauge 6598), else
-- other. A decoded burst is grouped by its address, a corrupted copy by its
-- true address.


-- ── blocks.csv ───────────────────────────────────────────────────────────────
-- Each Brisbane day from 7 to 28 October, with 24 October cut at 11:16 (our
-- receiver's software update) and 25 October at 04:35 (Toowoomba's last
-- transmission): bursts decoded and corrupted copies found, per channel and
-- group. "clear" = the corrupted copy within 6 dB of the clean one, as strong
-- as it, so sent wrong rather than misheard.
with cuts(t) as (
  select g from generate_series('2026-10-07 00:00+10'::timestamptz, '2026-10-29 00:00+10', interval '1 day') g
  union select '2026-10-24 11:16+10'::timestamptz
  union select '2026-10-25 04:35+10'::timestamptz),
blocks as (select a, z from (select t as a, lead(t) over (order by t) as z from cuts) s where z is not null),
grp as (select x, case
    when x between 4000 and 4099 or x in (6526, 6527, 6598) then 'toowoomba'
    else 'other' end g from generate_series(0, 8191) x),
dec as (select b.a, round(r.freq_mhz::numeric, 3) ch, grp.g, count(*) n
  from blocks b join meganet.reception r on r.heard_at >= b.a and r.heard_at < b.z
  join grp on grp.x = r.alert_id
  where r.protocol = 'alert' and r.ok and round(r.freq_mhz::numeric, 3) in (151.500, 151.525)
  group by 1, 2, 3),
bad as (select b.a, round(r.freq_mhz::numeric, 3) ch, grp.g, count(*) n,
    count(*) filter (where f.bad_snr >= f.good_snr - 6) clear
  from blocks b join meganet.flip_event f on f.heard_at >= b.a and f.heard_at < b.z
  join meganet.reception r on r.id = f.bad_reception_id
  join grp on grp.x = f.true_addr
  where round(r.freq_mhz::numeric, 3) in (151.500, 151.525)
  group by 1, 2, 3),
rows as (select b.a, b.z, c.ch, g.g, coalesce(d.n, 0) dn, coalesce(x.n, 0) xn, coalesce(x.clear, 0) xc
  from blocks b cross join (values (151.500), (151.525)) c(ch)
  cross join (values ('toowoomba'), ('other')) g(g)
  left join dec d on d.a = b.a and d.ch = c.ch and d.g = g.g
  left join bad x on x.a = b.a and x.ch = c.ch and x.g = g.g)
select 'start,end,channel_mhz,group,decoded,corrupted,clear' || chr(10) || string_agg(
    to_char(a at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || ',' ||
    to_char(z at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || ',' ||
    to_char(ch, 'FM999.000') || ',' || g || ',' || dn || ',' || xn || ',' || xc, chr(10) order by a, ch, g) as csv
from rows;


-- ── carriers.csv ─────────────────────────────────────────────────────────────
-- Carrier offsets, recorded from 22:02 on 21 October: every decoded burst on
-- Toowoomba's channel in 20 Hz bins, before and after 04:35 on 25 October,
-- with how many were in Toowoomba's ranges or from its own gauge (6598), and
-- how many corrupted copies came on a carrier in the bin. Bins with fewer
-- than three bursts are left out.
with r as (select r.id, r.heard_at, round(r.freq_mhz::numeric, 3) ch, r.alert_id,
    (floor(r.cfo_hz / 20) * 20)::int bin,
    case when r.heard_at < '2026-10-25 04:35+10' then 'before' else 'after' end per
  from meganet.reception r
  where r.protocol = 'alert' and r.ok and r.cfo_hz is not null
    and round(r.freq_mhz::numeric, 3) = 151.525
    and r.heard_at >= '2026-10-21 22:00+10' and r.heard_at < '2026-10-29 00:00+10'),
dec as (select ch, per, bin, count(*) n,
    count(*) filter (where alert_id between 4000 and 4099 or alert_id in (6526, 6527, 6598)) tw,
    count(*) filter (where alert_id = 6598) tw_own
  from r group by 1, 2, 3),
bad as (select r.ch, r.per, r.bin, count(*) n from meganet.flip_event f join r on r.id = f.bad_reception_id group by 1, 2, 3)
select 'channel_mhz,period,carrier_hz,decoded,toowoomba_range,toowoomba_own,corrupted' || chr(10) || string_agg(
    to_char(d.ch, 'FM999.000') || ',' || d.per || ',' || d.bin || ',' || d.n || ',' || d.tw || ',' || d.tw_own || ',' ||
    coalesce(b.n, 0), chr(10) order by d.ch, d.per desc, d.bin) as csv
from dec d left join bad b using (ch, per, bin)
where d.n >= 3;


-- ── toowoomba_own.csv ────────────────────────────────────────────────────────
-- Every decoded report from Toowoomba AL's own rain gauge (6598) on its
-- channel, from 6 October: when, the count, and (from 21 October) its carrier
-- and signal-to-noise.
select 'heard,value,carrier_hz,snr_db' || chr(10) || string_agg(
    to_char(heard_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI:SS') || ',' || value_raw || ',' ||
    coalesce(round(cfo_hz::numeric)::text, '') || ',' || coalesce(round(snr_db::numeric, 1)::text, ''),
    chr(10) order by heard_at) as csv
from meganet.reception
where protocol = 'alert' and ok and alert_id = 6598 and round(freq_mhz::numeric, 3) = 151.525
  and heard_at >= '2026-10-06 00:00+10' and heard_at < '2026-10-29 00:00+10';


-- ── transmitters.csv ─────────────────────────────────────────────────────────
-- meganet.flip_summary as refresh_transmitter_findings() last judged it:
-- Toowoomba's and Mt Glorious's last 7 days, by the carrier their bursts came
-- on, and the typical transmitter's rate. Public.
select 'tx,station_id,bursts,corrupted,clear,clean_upstream,fleet_rate,judged_at' || chr(10) || string_agg(
    tx || ',' || coalesce(station_id, '') || ',' || bursts || ',' || flips || ',' || clear || ',' || clean_upstream || ',' ||
    round(fleet_rate::numeric, 5) || ',' || to_char(judged_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI'),
    chr(10) order by flips desc, tx) as csv
from meganet.flip_summary
where tx in ('st:toowoomba_al', 'st:mt_glorious_al_rptr');
