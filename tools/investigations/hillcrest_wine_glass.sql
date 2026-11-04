-- Investigation 03 — Hillcrest (Wine Glass). The eleven exports in
-- data/investigations/2026-11-hillcrest-wine-glass/, each query returning one
-- cell of CSV text: paste it into the file named above the query.
--
-- Read-only, and run as a role that can read meganet.flip_event,
-- meganet.reception and meganet.carrier_daily (the service key's and
-- editors'; none is public). No export names a receiver, a base station or a
-- token: every row is a channel, a time, an address, a carrier offset or a
-- transmitter. Times are Brisbane (UTC+10).
--
-- Legacy ALERT only (protocol 'alert'), on 151.500 MHz, Hillcrest AL (Wine
-- Glass)'s channel: it hears and relays on 151.500. Flood-Net's receiver has
-- heard that channel throughout, and has measured each burst's carrier offset
-- since 22:00 on 21 October, so the carrier queries run over the 13 whole days
-- from 22 October to 3 November.
--
-- Hillcrest's carrier is taken as 120 to 240 Hz (lower edge in, upper out).
-- carriers.csv is the evidence for it. Its pass ranges in stations.json are
-- 1900–2200, 4151–4199, 4800–4899, 5304–5399 and 6200–6274 (its own rain 6200
-- and battery 6201 among them). Constitution Hill, the other repeater on
-- 151.500 that passes most of them, passes 1900–2200, 4100–4199, 4800–4899,
-- 5304–5312, 5500–5550 and 6200–6299. So 5313–5399, less Kooralbyn AL's
-- 5386–5388, is Hillcrest's alone on this channel, and 4100–4150, 5500–5550 and
-- 6275–6299 are Constitution Hill's (and Round Mt Res's), not Hillcrest's.
--
-- A corrupted copy is a row of meganet.flip_event (0078): a burst one or two
-- bits from a real one, on the same receiver within five seconds. "Same
-- burst" = heard at the same instant as its clean twin (|gap| under 5 ms): the
-- receiver stamps every frame it decodes from one burst with that burst's end,
-- so these are one burst decoded two ways. "Separate" = in a burst of its own.


-- ── carriers.csv ─────────────────────────────────────────────────────────────
-- Every decoded burst on 151.500 with a carrier offset, in 20 Hz bins (lower
-- edges): how many, how many from addresses only Hillcrest relays here, only
-- Constitution Hill does, or both do, how many from Hillcrest's own sensors,
-- and how many were corrupted copies, same burst or separate. Bins with fewer
-- than three bursts are left out.
with r as (select r.id, r.alert_id a, (floor(r.cfo_hz / 20) * 20)::int bin
  from meganet.reception r
  where r.protocol = 'alert' and r.ok and r.cfo_hz is not null and round(r.freq_mhz::numeric, 3) = 151.500
    and r.heard_at >= '2026-10-22 00:00+10' and r.heard_at < '2026-11-04 00:00+10'),
f as (select distinct on (bad_reception_id) bad_reception_id id, abs(gap_s) < 0.005 same
  from meganet.flip_event where heard_at >= '2026-10-21 23:00+10' and heard_at < '2026-11-04 01:00+10'
  order by bad_reception_id, abs(gap_s)),
s as (select bin, count(*) n,
    count(*) filter (where a between 5313 and 5385 or a between 5389 and 5399) hc_only,
    count(*) filter (where a between 4100 and 4150 or a between 5500 and 5550 or a between 6275 and 6299) ch_only,
    count(*) filter (where a between 1900 and 2200 or a between 4151 and 4199 or a between 4800 and 4899
                        or a between 5304 and 5312 or a between 6200 and 6274) shared,
    count(*) filter (where a in (6200, 6201)) own,
    count(f.id) filter (where f.same) same, count(f.id) filter (where not f.same) sep
  from r left join f using (id) group by bin)
select 'carrier_hz,decoded,hillcrest_only,constitution_only,shared,own,corrupted_same_burst,corrupted_separate' || chr(10) ||
  string_agg(bin || ',' || n || ',' || hc_only || ',' || ch_only || ',' || shared || ',' || own || ',' || same || ',' || sep,
             chr(10) order by bin) as csv
from s where n >= 3;


-- ── addresses.csv ────────────────────────────────────────────────────────────
-- Each address only Hillcrest relays on 151.500, and each only Constitution
-- Hill (or Round Mt Res) does, heard three times or more with a carrier: how
-- many of its bursts came on Hillcrest's carrier and how many elsewhere.
select 'group,addr,on_hillcrest,elsewhere' || chr(10) || string_agg(g || ',' || a || ',' || h || ',' || e, chr(10) order by g, a) as csv
from (select case when alert_id between 5313 and 5399 then 'hillcrest_only' else 'constitution_only' end g, alert_id a,
        count(*) filter (where cfo_hz >= 120 and cfo_hz < 240) h, count(*) filter (where not (cfo_hz >= 120 and cfo_hz < 240)) e
      from meganet.reception
      where protocol = 'alert' and ok and cfo_hz is not null and round(freq_mhz::numeric, 3) = 151.500
        and heard_at >= '2026-10-22 00:00+10' and heard_at < '2026-11-04 00:00+10'
        and (alert_id between 5313 and 5385 or alert_id between 5389 and 5399 or alert_id between 4100 and 4150
             or alert_id between 5500 and 5550 or alert_id between 6275 and 6299)
      group by 1, 2 having count(*) >= 3) s;

-- ── blocks.csv ───────────────────────────────────────────────────────────────
-- Each three hours from 22 October to 3 November: bursts decoded on
-- Hillcrest's carrier, on the channel's other carriers and with no carrier
-- measured (a burst holding two transmitters back to back, or too short);
-- reports from Hillcrest's own rain gauge (6200, every copy, any carrier); and
-- the corrupted copies on Hillcrest's carrier, same burst and separate.
with blocks as (select g a, g + interval '3 hours' z
  from generate_series('2026-10-22 00:00+10'::timestamptz, '2026-11-03 21:00+10', interval '3 hours') g),
r as (select r.id, r.heard_at, r.cfo_hz, r.alert_id, coalesce(r.cfo_hz >= 120 and r.cfo_hz < 240, false) hc
  from meganet.reception r
  where r.protocol = 'alert' and r.ok and round(r.freq_mhz::numeric, 3) = 151.500
    and r.heard_at >= '2026-10-22 00:00+10' and r.heard_at < '2026-11-04 00:00+10'),
f as (select distinct on (bad_reception_id) bad_reception_id id, abs(gap_s) < 0.005 same
  from meganet.flip_event where heard_at >= '2026-10-21 23:00+10' and heard_at < '2026-11-04 01:00+10'
  order by bad_reception_id, abs(gap_s)),
x as (select b.a,
    count(r.id) filter (where r.hc) hc,
    count(r.id) filter (where r.cfo_hz is not null and not r.hc) other,
    count(r.id) filter (where r.id is not null and r.cfo_hz is null) none,
    count(r.id) filter (where r.alert_id = 6200) gauge,
    count(f.id) filter (where r.hc and f.same) hc_same,
    count(f.id) filter (where r.hc and not f.same) hc_sep
  from blocks b left join r on r.heard_at >= b.a and r.heard_at < b.z left join f on f.id = r.id
  group by b.a)
select 'start,hillcrest_carrier,other_carriers,no_carrier,gauge_reports,hillcrest_same_burst,hillcrest_separate' || chr(10) ||
  string_agg(to_char(a at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || ',' || hc || ',' || other || ',' || none || ',' ||
             gauge || ',' || hc_same || ',' || hc_sep, chr(10) order by a) as csv
from x;


-- ── levels.csv ───────────────────────────────────────────────────────────────
-- Each three hours from 22 October to 3 November, how strongly the receiver
-- heard the channel: the median signal-to-noise ratio of the bursts decoded on
-- Hillcrest's carrier and on the channel's other carriers, and the median
-- noise floor and burst level the receiver measured (dB below its full scale,
-- so a change in its gain moves both).
with blocks as (select g a, g + interval '3 hours' z
  from generate_series('2026-10-22 00:00+10'::timestamptz, '2026-11-03 21:00+10', interval '3 hours') g),
r as (select r.heard_at, r.snr_db, r.nf_dbfs, r.level_dbfs, coalesce(r.cfo_hz >= 120 and r.cfo_hz < 240, false) hc, r.cfo_hz is not null c
  from meganet.reception r
  where r.protocol = 'alert' and r.ok and round(r.freq_mhz::numeric, 3) = 151.500
    and r.heard_at >= '2026-10-22 00:00+10' and r.heard_at < '2026-11-04 00:00+10'),
x as (select b.a,
    percentile_cont(0.5) within group (order by r.snr_db) filter (where r.hc) hs,
    percentile_cont(0.5) within group (order by r.snr_db) filter (where r.c and not r.hc) os,
    percentile_cont(0.5) within group (order by r.nf_dbfs) nf,
    percentile_cont(0.5) within group (order by r.level_dbfs) lv
  from blocks b left join r on r.heard_at >= b.a and r.heard_at < b.z group by b.a)
select 'start,hillcrest_snr_db,other_snr_db,noise_floor_dbfs,level_dbfs' || chr(10) ||
  string_agg(to_char(a at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || ',' || coalesce(round(hs::numeric, 1)::text, '') || ',' ||
             coalesce(round(os::numeric, 1)::text, '') || ',' || coalesce(round(nf::numeric, 1)::text, '') || ',' ||
             coalesce(round(lv::numeric, 1)::text, ''), chr(10) order by a) as csv
from x;

-- ── snr.csv ──────────────────────────────────────────────────────────────────
-- Decoded bursts on 151.500 with a carrier and a signal-to-noise ratio, by
-- whole decibels (8 or less as 8, 16 or more as 16), on Hillcrest's carrier or
-- another, with the corrupted copies among them, same burst and separate.
with r as (select r.id, coalesce(r.cfo_hz >= 120 and r.cfo_hz < 240, false) hc, least(greatest(floor(r.snr_db)::int, 8), 16) s
  from meganet.reception r
  where r.protocol = 'alert' and r.ok and r.cfo_hz is not null and r.snr_db is not null
    and round(r.freq_mhz::numeric, 3) = 151.500
    and r.heard_at >= '2026-10-22 00:00+10' and r.heard_at < '2026-11-04 00:00+10'),
f as (select distinct on (bad_reception_id) bad_reception_id id, abs(gap_s) < 0.005 same
  from meganet.flip_event where heard_at >= '2026-10-21 23:00+10' and heard_at < '2026-11-04 01:00+10'
  order by bad_reception_id, abs(gap_s)),
x as (select s, hc, count(*) n, count(f.id) filter (where f.same) same, count(f.id) filter (where not f.same) sep
  from r left join f using (id) group by 1, 2)
select 'snr_db,carrier,decoded,corrupted_same_burst,corrupted_separate' || chr(10) ||
  string_agg(s || ',' || case when hc then 'hillcrest' else 'other' end || ',' || n || ',' || same || ',' || sep,
             chr(10) order by hc desc, s) as csv
from x;


-- ── checked.csv ──────────────────────────────────────────────────────────────
-- How often a relay that could be checked came through corrupted. A burst can
-- be checked when the same reading (address and value) also reached the
-- receiver in another burst 0.3 to 5 seconds away: its twin. For Hillcrest's
-- carrier, the channel's other carriers, bursts with no carrier, and for scale
-- 151.525 (Toowoomba's channel, investigation 02) over the same days: bursts,
-- clean ones with a twin, and corrupted copies, separate and same burst.
with r as (select r.id, r.heard_at, r.alert_id, r.value_raw, r.cfo_hz, round(r.freq_mhz::numeric, 3) ch
  from meganet.reception r
  where r.protocol = 'alert' and r.ok and round(r.freq_mhz::numeric, 3) in (151.500, 151.525)
    and r.heard_at >= '2026-10-22 00:00+10' and r.heard_at < '2026-11-04 00:00+10'),
f as (select distinct on (bad_reception_id) bad_reception_id id, abs(gap_s) < 0.005 same
  from meganet.flip_event where heard_at >= '2026-10-21 23:00+10' and heard_at < '2026-11-04 01:00+10'
  order by bad_reception_id, abs(gap_s)),
g as (select r.*, case when r.ch = 151.525 then '151.525'
                       when r.cfo_hz >= 120 and r.cfo_hz < 240 then 'hillcrest'
                       when r.cfo_hz is null then 'no_carrier' else 'other' end grp, f.id is not null bad, f.same
  from r left join f using (id)),
t as (select h.grp, count(*) n from g h
  where not h.bad and exists (select 1 from r o where o.ch = h.ch and o.alert_id = h.alert_id and o.value_raw = h.value_raw
    and o.id <> h.id and o.heard_at between h.heard_at - interval '5 s' and h.heard_at + interval '5 s'
    and abs(extract(epoch from o.heard_at - h.heard_at)) >= 0.3)
  group by 1),
x as (select grp, count(*) n, count(*) filter (where bad and not same) sep, count(*) filter (where bad and same) same from g group by 1)
select 'group,decoded,clean_with_twin,corrupted_separate,corrupted_same_burst' || chr(10) ||
  string_agg(x.grp || ',' || x.n || ',' || coalesce(t.n, 0) || ',' || x.sep || ',' || x.same, chr(10) order by x.grp) as csv
from x left join t using (grp);


-- ── separate.csv ─────────────────────────────────────────────────────────────
-- Every corrupted copy on Hillcrest's carrier in a burst of its own: when, the
-- true and corrupted address and value, the bits changed, seconds after its
-- clean twin (negative: before it), its signal-to-noise against the twin's,
-- and where the twin came from (Hillcrest's carrier, another, or none
-- measured).
select 'heard,true_addr,true_value,bad_addr,bad_value,bits,gap_s,snr_db,twin_snr_db,twin_carrier' || chr(10) ||
  string_agg(to_char(f.heard_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI:SS') || ',' || f.true_addr || ',' ||
             f.true_value || ',' || f.bad_addr || ',' || f.bad_value || ',' || f.bits || ',' || round(f.gap_s::numeric, 2) || ',' ||
             coalesce(round(f.bad_snr::numeric, 1)::text, '') || ',' || coalesce(round(f.good_snr::numeric, 1)::text, '') || ',' ||
             case when g.cfo_hz is null then 'none' when g.cfo_hz >= 120 and g.cfo_hz < 240 then 'hillcrest' else 'other' end,
             chr(10) order by f.heard_at) as csv
from meganet.flip_event f
join meganet.reception b on b.id = f.bad_reception_id
join meganet.reception g on g.id = f.good_reception_id
where round(b.freq_mhz::numeric, 3) = 151.500 and b.cfo_hz >= 120 and b.cfo_hz < 240 and abs(f.gap_s) >= 0.005
  and b.heard_at >= '2026-10-22 00:00+10' and b.heard_at < '2026-11-04 00:00+10';


-- ── pairs.csv ────────────────────────────────────────────────────────────────
-- The same-burst pairs on 151.500, on Hillcrest's carrier or another: how many,
-- how many where the corrupted frame had fewer decoder votes than the clean
-- one (votes: in how many of the decoder's 45 carrier and timing guesses the
-- frame turned up), and the median votes of each.
select 'carrier,pairs,fewer_votes,bad_votes_median,good_votes_median' || chr(10) ||
  string_agg(grp || ',' || n || ',' || fewer || ',' || bv || ',' || gv, chr(10) order by grp) as csv
from (select case when b.cfo_hz >= 120 and b.cfo_hz < 240 then 'hillcrest' else 'other' end grp, count(*) n,
        count(*) filter (where b.votes < g.votes) fewer,
        percentile_cont(0.5) within group (order by b.votes) bv, percentile_cont(0.5) within group (order by g.votes) gv
      from meganet.flip_event f
      join meganet.reception b on b.id = f.bad_reception_id
      join meganet.reception g on g.id = f.good_reception_id
      where round(b.freq_mhz::numeric, 3) = 151.500 and b.cfo_hz is not null and abs(f.gap_s) < 0.005
        and b.heard_at >= '2026-10-22 00:00+10' and b.heard_at < '2026-11-04 00:00+10'
      group by 1) s;


-- ── own.csv ──────────────────────────────────────────────────────────────────
-- Every decoded report from Hillcrest's own rain gauge (6200) and battery
-- (6201) on 151.500 from 7 October: when, the value as sent, and (from 21
-- October) its carrier and signal-to-noise; copy = 1 for a second copy of a
-- reading already heard.
select 'heard,addr,value,carrier_hz,snr_db,votes,copy' || chr(10) ||
  string_agg(to_char(heard_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI:SS') || ',' || alert_id || ',' || value_raw || ',' ||
             coalesce(round(cfo_hz::numeric)::text, '') || ',' || coalesce(round(snr_db::numeric, 1)::text, '') || ',' ||
             coalesce(votes::text, '') || ',' || case when a2_duplicate then 1 else 0 end, chr(10) order by heard_at, alert_id) as csv
from meganet.reception
where protocol = 'alert' and ok and alert_id in (6200, 6201) and round(freq_mhz::numeric, 3) = 151.500
  and heard_at >= '2026-10-07 00:00+10' and heard_at < '2026-11-04 00:00+10';


-- ── credited.csv ─────────────────────────────────────────────────────────────
-- Who Flood-Net's carrier table (meganet.carrier_daily, 0077) put the bursts
-- on Hillcrest's carrier down to: each transmitter whose 151.500 bursts on the
-- days 22 October to 3 November averaged 120 to 240 Hz, with ten bursts or
-- more, how (own = heard direct; repeater = relayed), its bursts and its
-- average carrier.
select 'tx,how,bursts,carrier_hz' || chr(10) ||
  string_agg(tx || ',' || via || ',' || n || ',' || round(cfo::numeric), chr(10) order by n desc, tx) as csv
from (select tx, via, sum(n) n, sum(cfo_sum) / nullif(sum(n), 0) cfo
      from meganet.carrier_daily
      where protocol = 'alert' and round(freq_mhz::numeric, 3) = 151.500 and day >= '2026-10-22' and day <= '2026-11-03'
      group by 1, 2) s
where cfo >= 120 and cfo < 240 and n >= 10;


-- ── transmitters.csv ─────────────────────────────────────────────────────────
-- meganet.flip_summary as refresh_transmitter_findings() last judged it, for
-- Hillcrest, and the typical transmitter's rate. Public.
select 'tx,station_id,bursts,corrupted,clear,clean_upstream,fleet_rate,judged_at' || chr(10) || string_agg(
    tx || ',' || coalesce(station_id, '') || ',' || bursts || ',' || flips || ',' || clear || ',' || clean_upstream || ',' ||
    round(fleet_rate::numeric, 5) || ',' || to_char(judged_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI'),
    chr(10) order by tx) as csv
from meganet.flip_summary
where tx = 'st:hillcrest_wine_glass';
