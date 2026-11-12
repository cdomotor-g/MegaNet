-- 0120_tdma_slots.sql — The slot table on file: which ALERT2 transmitter owns
-- which time slot on which channel, and the ALERT2 IDs that go with them.
--
-- Why this file exists
-- ────────────────────
-- The TDMA Planner tab (tdma-planner.js) works out a slot plan from first
-- principles, and keeps it on the device that made it. Nothing held the slots
-- the network actually runs. On 12 November 2026 the owner supplied the slot
-- sheet for the Mt Glorious ALERT2 network — four channels, a transmitter's
-- site and ALERT2 ID against every half-second slot it owns:
--
--   151.5375 MHz  field stations heard through the repeaters   60 s frame
--   152.4625 MHz  field stations heard direct by Mt Glorious    60 s frame
--   173.9    MHz  Mt Glorious Primary                           0–9.5 s
--   173.95   MHz  Mt Glorious Secondary                         10–19.5 s
--
-- The sheet's slots run 0–59.5 s on the first two channels, and 0–19.5 s on
-- the last two, where Primary holds the first ten seconds and Secondary the
-- next ten; the frame lengths here are read off the sheet, not a radio.
--
-- What it does
-- ────────────
--   1. meganet.tdma_channel — one row a channel: frequency, what it is for,
--      frame and slot length.
--   2. meganet.tdma_slot — one row an occupied slot: channel, start (seconds
--      into the frame), the ALERT2 ID that transmits in it, the site as the
--      sheet names it, and the register station it is, where that is known.
--      A slot holds one transmitter (that is TDMA), so (channel, start) is the
--      key. An empty slot has no row: it is spare.
--   3. The sheet's 151 occupied slots.
--   4. station.alert2_station_id (0024) for the 17 sites that match exactly one
--      register station. The rest — several register stations at one weir or
--      hill, or none at all — are left for a person: the slot keeps the site's
--      name and ID, and the TDMA Planner's slot table says which are unlinked.
--   5. meganet.tdma_heard(days) — what the base stations heard of each ALERT2
--      ID, by channel, from the daily reception rollup (0071): as the source,
--      as a repeater on the path, and when last. Public: no receiver is named.
--   6. tdma_slot_save(), tdma_site_save(), tdma_slot_remove() — editors only.
--
-- Everybody may read the slot table, as everybody may read the station list
-- and its frequencies (0033): channels and ALERT2 IDs are what any receiver on
-- the channel hears. Idempotent and forward-only, per db/README.md.

-- ── 1. Channels ──────────────────────────────────────────────────────────────
create table if not exists meganet.tdma_channel (
  freq_mhz   numeric(9,4) primary key check (freq_mhz > 0 and freq_mhz < 1000),
  label      text not null,
  frame_s    numeric(7,1) not null check (frame_s >= 5 and frame_s <= 3600),
  slot_s     numeric(4,2) not null default 0.5 check (slot_s >= 0.25 and slot_s <= 10),
  notes      text,
  ord        integer not null default 0,
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by text
);
comment on table meganet.tdma_channel is
  'An ALERT2 TDMA channel on file (0120): its frequency, what it carries, its frame and its slot length. Its slots are meganet.tdma_slot.';

-- ── 2. Slots ─────────────────────────────────────────────────────────────────
create table if not exists meganet.tdma_slot (
  freq_mhz   numeric(9,4) not null references meganet.tdma_channel (freq_mhz) on update cascade,
  slot_s     numeric(7,2) not null check (slot_s >= 0),
  alert2_id  integer check (alert2_id between 1 and 65534),
  site       text not null check (pg_catalog.length(pg_catalog.btrim(site)) between 1 and 120),
  station_id text references meganet.station (id) on update cascade on delete set null,
  notes      text,
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by text,
  primary key (freq_mhz, slot_s)
);
comment on table meganet.tdma_slot is
  'One occupied ALERT2 time slot (0120): the channel, the slot''s start in seconds into the frame, the ALERT2 ID that transmits in it, the site as the slot sheet names it, and the register station it is where known. No row means a spare slot.';
create index if not exists tdma_slot_alert2_idx  on meganet.tdma_slot (alert2_id);
create index if not exists tdma_slot_station_idx on meganet.tdma_slot (station_id);

-- A slot starts on a slot boundary inside its frame. A trigger rather than a
-- check, because the frame and slot length are the channel's.
create or replace function meganet.tdma_slot_fits()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_frame numeric;
  v_slot  numeric;
begin
  select c.frame_s, c.slot_s into v_frame, v_slot
    from meganet.tdma_channel c where c.freq_mhz = new.freq_mhz;
  if new.slot_s >= v_frame then
    raise exception 'slot % s is past the end of the % s frame on % MHz', new.slot_s, v_frame, new.freq_mhz
      using errcode = '22023';
  end if;
  if pg_catalog.mod(new.slot_s, v_slot) <> 0 then
    raise exception 'slot % s does not start on a % s slot boundary on % MHz', new.slot_s, v_slot, new.freq_mhz
      using errcode = '22023';
  end if;
  new.site := pg_catalog.btrim(new.site);
  return new;
end
$$;
drop trigger if exists tdma_slot_fits on meganet.tdma_slot;
create trigger tdma_slot_fits before insert or update on meganet.tdma_slot
  for each row execute function meganet.tdma_slot_fits();

alter table meganet.tdma_channel enable row level security;
alter table meganet.tdma_slot    enable row level security;
drop policy if exists tdma_channel_read_all on meganet.tdma_channel;
create policy tdma_channel_read_all on meganet.tdma_channel for select using (true);
drop policy if exists tdma_slot_read_all on meganet.tdma_slot;
create policy tdma_slot_read_all on meganet.tdma_slot for select using (true);

-- ── 3. The sheet ─────────────────────────────────────────────────────────────
insert into meganet.tdma_channel (freq_mhz, label, frame_s, slot_s, ord, notes, updated_by) values
  (151.5375, 'Field stations heard through the repeaters', 60, 0.5, 1, 'From the slot sheet of 12 November 2026.', '0120'),
  (152.4625, 'Field stations heard direct by Mt Glorious', 60, 0.5, 2, 'From the slot sheet of 12 November 2026.', '0120'),
  (173.9,    'Mt Glorious Primary',                        20, 0.5, 3, 'From the slot sheet of 12 November 2026. The sheet lists 0–19.5 s; Primary holds 0–9.5 s.', '0120'),
  (173.95,   'Mt Glorious Secondary',                      20, 0.5, 4, 'From the slot sheet of 12 November 2026. The sheet lists 0–19.5 s; Secondary holds 10–19.5 s.', '0120')
on conflict (freq_mhz) do nothing;

-- Only where the slot is still empty: a later edit in the app is not undone by
-- running this file again. A station id the register does not have is left out.
insert into meganet.tdma_slot (freq_mhz, slot_s, alert2_id, site, station_id, updated_by)
select v.f, v.s, v.a, v.site,
       (select st.id from meganet.station st where st.id = v.st and st.deleted_at is null),
       '0120'
  from (values
  (151.5375, 0, 11058, 'Fords Rd Reserve', 'fords_rd_al'),
  (151.5375, 0.5, 8233, 'Gympie Weir', 'gympie_weir_tm'),
  (151.5375, 1, 11081, 'Cedar Grove', null),
  (151.5375, 1.5, 11081, 'Cedar Grove', null),
  (151.5375, 2.5, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 3, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 3.5, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 4, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 4.5, 11082, 'Maroon Dam TW', 'maroon_dam_tw_tm'),
  (151.5375, 6, 10290, 'Black snake Ck @ Mockers Rd', null),
  (151.5375, 6.5, 10290, 'Black snake Ck @ Mockers Rd', null),
  (151.5375, 7.5, 8234, 'Borumba Dam Repeater', null),
  (151.5375, 8, 8234, 'Borumba Dam Repeater', null),
  (151.5375, 8.5, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 9, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 9.5, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 10, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 11, 11047, 'Bromelton Weir HW/TW', null),
  (151.5375, 11.5, 11047, 'Bromelton Weir HW/TW', null),
  (151.5375, 12, 11047, 'Bromelton Weir HW/TW', null),
  (151.5375, 13, 10315, 'Mt Pechey', null),
  (151.5375, 13.5, 10315, 'Mt Pechey', null),
  (151.5375, 14, 10315, 'Mt Pechey', null),
  (151.5375, 14.5, 10315, 'Mt Pechey', null),
  (151.5375, 15, 10020, 'Clarendon Weir', 'clarendon_tm'),
  (151.5375, 15.5, 9600, 'Wirth Crossing', null),
  (151.5375, 16, 10004, 'Jimna RF Repeater', 'jimna_al'),
  (151.5375, 16.5, 10004, 'Jimna RF Repeater', 'jimna_al'),
  (151.5375, 17, 10004, 'Jimna RF Repeater', 'jimna_al'),
  (151.5375, 17.5, 10004, 'Jimna RF Repeater', 'jimna_al'),
  (151.5375, 18, 11762, 'Tallai', 'tallai_al'),
  (151.5375, 18.5, 11762, 'Tallai', 'tallai_al'),
  (151.5375, 19, 11762, 'Tallai', 'tallai_al'),
  (151.5375, 19.5, 11762, 'Tallai', 'tallai_al'),
  (151.5375, 20, 8278, 'Maleny WWTP', null),
  (151.5375, 20.5, 8278, 'Maleny WWTP', null),
  (151.5375, 21.5, 10314, 'Rassmussen Rd', null),
  (151.5375, 22, 33300, 'Toowoomba RPTR', 'toowoomba_al'),
  (151.5375, 22.5, 10163, 'Redbank Pump Station', null),
  (151.5375, 23.5, 10234, 'Bob Bird''s Hut', null),
  (151.5375, 25, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 25.5, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 26, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 26.5, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 27, 10057, 'Devon Hills Repeater', 'devon_hills_al'),
  (151.5375, 27.5, 10057, 'Devon Hills Repeater', 'devon_hills_al'),
  (151.5375, 28, 10134, 'Mt Mee Repeater', null),
  (151.5375, 28.5, 10134, 'Mt Mee Repeater', null),
  (151.5375, 29, 10134, 'Mt Mee Repeater', null),
  (151.5375, 29.5, 10134, 'Mt Mee Repeater', null),
  (151.5375, 30, 11099, 'White Swamp', 'white_swamp_al'),
  (151.5375, 30.5, 11099, 'White Swamp', 'white_swamp_al'),
  (151.5375, 31, 11099, 'White Swamp', 'white_swamp_al'),
  (151.5375, 31.5, 11099, 'White Swamp', 'white_swamp_al'),
  (151.5375, 32, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 32.5, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 33, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 33.5, 10019, 'Mt Crosby Rptr', null),
  (151.5375, 35.5, 10045, 'Kentville Weir', null),
  (151.5375, 36, 9580, 'Wararba Weir', null),
  (151.5375, 36.5, 10100, 'Kilcoy RF/Rptr', 'kilcoy_al'),
  (151.5375, 37, 10100, 'Kilcoy RF/Rptr', 'kilcoy_al'),
  (151.5375, 37.5, 10100, 'Kilcoy RF/Rptr', 'kilcoy_al'),
  (151.5375, 38.5, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 39, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 39.5, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 40, 11056, 'Mt Cotton West', 'mt_cotton_west_al'),
  (151.5375, 41, 11086, 'Leslie Harrison Dam HW - Backup', 'leslie_harrison_dam_hw_tm'),
  (151.5375, 43, 10315, 'Mt Pechey', null),
  (151.5375, 43.5, 10315, 'Mt Pechey', null),
  (151.5375, 44, 10315, 'Mt Pechey', null),
  (151.5375, 44.5, 10315, 'Mt Pechey', null),
  (151.5375, 45, 11088, 'Wyaralong Dam TW', null),
  (151.5375, 52, null, 'Mt Mee RF', null),
  (151.5375, 52.5, null, 'Mt Mee RF', null),
  (151.5375, 53, null, 'Mt Mee RF', null),
  (151.5375, 53.5, null, 'Mt Mee RF', null),
  (151.5375, 55, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 55.5, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 56, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 56.5, 10083, 'Yarraman', 'yarraman_al'),
  (151.5375, 57, 10057, 'Devon Hills Repeater', 'devon_hills_al'),
  (151.5375, 57.5, 10057, 'Devon Hills Repeater', 'devon_hills_al'),
  (151.5375, 58, 10134, 'Mt Mee Repeater', null),
  (151.5375, 58.5, 10134, 'Mt Mee Repeater', null),
  (151.5375, 59, 10134, 'Mt Mee Repeater', null),
  (151.5375, 59.5, 10134, 'Mt Mee Repeater', null),
  (152.4625, 0, 10184, 'Bill Gun Dam HW (Rptr)', null),
  (152.4625, 0.5, 10184, 'Bill Gun Dam HW (Rptr)', null),
  (152.4625, 1, 10184, 'Bill Gun Dam HW (Rptr)', null),
  (152.4625, 1.5, 10184, 'Bill Gun Dam HW (Rptr)', null),
  (152.4625, 3.5, 10310, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 4, 10311, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 4.5, 10312, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 5, 10313, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 7, 10208, 'Moogerah Dam TW', 'moogerah_dam_tw_tm'),
  (152.4625, 8.5, 11048, 'Bromelton Weir RF', null),
  (152.4625, 9, 11048, 'Bromelton Weir RF', null),
  (152.4625, 9.5, 11048, 'Bromelton Weir RF', null),
  (152.4625, 10, 11048, 'Bromelton Weir RF', null),
  (152.4625, 20, 10156, 'Churchbank Weir TW', null),
  (152.4625, 24.5, 10042, 'Seven Mile Inlet Channel', null),
  (152.4625, 33.5, 10310, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 34, 10311, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 34.5, 10312, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 35, 10313, 'Mt Pechey RF (Rptr)', null),
  (152.4625, 36.5, 10293, 'Kent''s Lagoon Headwater', 'kents_lagoon_tm'),
  (152.4625, 40.5, 11070, 'South MacLean TW', 'south_maclean_tw_tm'),
  (152.4625, 47, 11070, 'South MacLean TW', 'south_maclean_tw_tm'),
  (152.4625, 47.5, 11070, 'South MacLean TW', 'south_maclean_tw_tm'),
  (152.4625, 51, 11039, 'South MacLean HW', 'south_maclean_tm'),
  (173.9, 0, 9511, 'Mt Glorious Primary', null),
  (173.9, 0.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 1, 9511, 'Mt Glorious Primary', null),
  (173.9, 1.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 2, 9511, 'Mt Glorious Primary', null),
  (173.9, 2.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 3, 9511, 'Mt Glorious Primary', null),
  (173.9, 3.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 4, 9511, 'Mt Glorious Primary', null),
  (173.9, 4.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 5, 9511, 'Mt Glorious Primary', null),
  (173.9, 5.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 6, 9511, 'Mt Glorious Primary', null),
  (173.9, 6.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 7, 9511, 'Mt Glorious Primary', null),
  (173.9, 7.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 8, 9511, 'Mt Glorious Primary', null),
  (173.9, 8.5, 9511, 'Mt Glorious Primary', null),
  (173.9, 9, 9511, 'Mt Glorious Primary', null),
  (173.9, 9.5, 9511, 'Mt Glorious Primary', null),
  (173.95, 10, 9601, 'Mt Glorious Secondary', null),
  (173.95, 10.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 11, 9601, 'Mt Glorious Secondary', null),
  (173.95, 11.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 12, 9601, 'Mt Glorious Secondary', null),
  (173.95, 12.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 13, 9601, 'Mt Glorious Secondary', null),
  (173.95, 13.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 14, 9601, 'Mt Glorious Secondary', null),
  (173.95, 14.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 15, 9601, 'Mt Glorious Secondary', null),
  (173.95, 15.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 16, 9601, 'Mt Glorious Secondary', null),
  (173.95, 16.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 17, 9601, 'Mt Glorious Secondary', null),
  (173.95, 17.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 18, 9601, 'Mt Glorious Secondary', null),
  (173.95, 18.5, 9601, 'Mt Glorious Secondary', null),
  (173.95, 19, 9601, 'Mt Glorious Secondary', null),
  (173.95, 19.5, 9601, 'Mt Glorious Secondary', null)
  ) as v (f, s, a, site, st)
on conflict (freq_mhz, slot_s) do nothing;

-- ── 4. The ALERT2 ID on the station ──────────────────────────────────────────
-- Only on a station that has none, and only for an ID no other station holds
-- (0024's unique index would refuse it anyway).
update meganet.station st
   set alert2_station_id = x.alert2_id
  from (select distinct station_id, alert2_id from meganet.tdma_slot
         where station_id is not null and alert2_id is not null and updated_by = '0120') x
 where st.id = x.station_id
   and st.deleted_at is null
   and st.alert2_station_id is null
   and not exists (select 1 from meganet.station o
                    where o.alert2_station_id = x.alert2_id and o.deleted_at is null);

-- ── 5. What the base stations heard ──────────────────────────────────────────
-- From reception_daily: a few tens of thousands of rows, never the receptions
-- themselves. The frequency is put to the 12.5 kHz channel it is on, because
-- the rollup keeps it as a real (151.538 for 151.5375). A drive survey's
-- receptions are left out. No receiver, path or position leaves the function.
create or replace function meganet.tdma_heard(p_days integer default 30)
returns table (alert2_id integer, freq_mhz numeric, as_source bigint, as_relay bigint, last_heard timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with d as (
    select r.station, r.path, r.n_ok, r.last_heard,
           pg_catalog.round((pg_catalog.round((r.freq_min / 0.0125)::numeric) * 0.0125), 4) as f
      from meganet.reception_daily r
     where r.bucket >= pg_catalog.now() - pg_catalog.make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
       and r.protocol = 'alert2'
       and r.survey is null
       and r.freq_min is not null
  ), src as (
    select d.station as a, d.f, pg_catalog.sum(d.n_ok)::bigint as n, pg_catalog.max(d.last_heard) as t
      from d where d.station is not null and d.n_ok > 0 group by 1, 2
  ), rel as (
    select p.a, d.f, pg_catalog.sum(d.n_ok)::bigint as n, pg_catalog.max(d.last_heard) as t
      from d cross join lateral pg_catalog.unnest(d.path) as p (a)
     where d.n_ok > 0 group by 1, 2
  )
  select coalesce(src.a, rel.a), coalesce(src.f, rel.f),
         coalesce(src.n, 0), coalesce(rel.n, 0),
         greatest(src.t, rel.t)
    from src full join rel on rel.a = src.a and rel.f = src.f
   where coalesce(src.a, rel.a) between 1 and 65535;
$$;
comment on function meganet.tdma_heard(integer) is
  'What the base stations heard of each ALERT2 ID over the last 1–90 days (0120), by 12.5 kHz channel: decoded as the source, decoded with it on the repeater path, and when last. From reception_daily; no receiver is named. Public. For the TDMA Planner''s slot table.';

-- ── 6. Editing ───────────────────────────────────────────────────────────────
-- tdma_slot_save: put one site into a run of slots on one channel.
--   { freq_mhz, slot_s, slots (how many in a row, default 1), site, alert2_id,
--     station_id, notes }
-- A slot held by another site is taken over: the form shows which before it
-- saves. When a station is named with an ID and the station has none, the
-- station gets the ID too (and the answer says so).
create or replace function meganet.tdma_slot_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  text := meganet.actor();
  v_key    text;
  v_freq   numeric;
  v_start  numeric;
  v_n      integer;
  v_site   text;
  v_a2     integer;
  v_st     text;
  v_notes  text;
  v_slot   numeric;
  v_frame  numeric;
  v_taken  jsonb;
  v_linked boolean := false;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to change the slot table'
      using errcode = '42501', hint = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.tdma_slot_save() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('freq_mhz', 'slot_s', 'slots', 'site', 'alert2_id', 'station_id', 'notes') then
      raise exception 'meganet.tdma_slot_save() does not take %', v_key using errcode = '22023',
        hint = 'freq_mhz, slot_s, slots, site, alert2_id, station_id and notes are the whole list';
    end if;
  end loop;
  begin
    v_freq  := (p ->> 'freq_mhz')::numeric;
    v_start := (p ->> 'slot_s')::numeric;
    v_n     := coalesce(nullif(p ->> 'slots', '')::integer, 1);
    v_a2    := nullif(p ->> 'alert2_id', '')::integer;
  exception when others then
    raise exception 'the channel, the slot, the number of slots and the ALERT2 ID are numbers' using errcode = '22023';
  end;
  v_site  := nullif(pg_catalog.btrim(p ->> 'site'), '');
  v_st    := nullif(pg_catalog.btrim(p ->> 'station_id'), '');
  v_notes := nullif(pg_catalog.btrim(p ->> 'notes'), '');
  select c.slot_s, c.frame_s into v_slot, v_frame from meganet.tdma_channel c where c.freq_mhz = v_freq;
  if v_slot is null then
    raise exception 'no channel % MHz on file', v_freq using errcode = '22023';
  end if;
  if v_site is null then
    raise exception 'a slot needs the site that transmits in it' using errcode = '22023';
  end if;
  if v_n < 1 or v_n > 40 then
    raise exception 'between 1 and 40 slots in a row' using errcode = '22023';
  end if;
  if v_start is null or v_start < 0 or v_start + (v_n - 1) * v_slot >= v_frame then
    raise exception 'those slots do not fit the % s frame', v_frame using errcode = '22023';
  end if;
  if v_a2 is not null and (v_a2 < 1 or v_a2 > 65534) then
    raise exception 'an ALERT2 ID is 1–65534' using errcode = '22023';
  end if;
  if v_st is not null and not exists (select 1 from meganet.station where id = v_st and deleted_at is null) then
    raise exception 'no station % in the register', v_st using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('slot_s', s.slot_s, 'site', s.site, 'alert2_id', s.alert2_id) order by s.slot_s), '[]'::jsonb)
    into v_taken
    from meganet.tdma_slot s
   where s.freq_mhz = v_freq
     and s.slot_s >= v_start and s.slot_s <= v_start + (v_n - 1) * v_slot
     and (s.site is distinct from v_site or s.alert2_id is distinct from v_a2);

  insert into meganet.tdma_slot (freq_mhz, slot_s, alert2_id, site, station_id, notes, updated_at, updated_by)
  select v_freq, v_start + g * v_slot, v_a2, v_site, v_st, v_notes, pg_catalog.now(), v_actor
    from pg_catalog.generate_series(0, v_n - 1) g
  on conflict (freq_mhz, slot_s) do update
     set alert2_id = excluded.alert2_id, site = excluded.site, station_id = excluded.station_id,
         notes = excluded.notes, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  if v_st is not null and v_a2 is not null then
    update meganet.station st set alert2_station_id = v_a2
     where st.id = v_st and st.alert2_station_id is null
       and not exists (select 1 from meganet.station o where o.alert2_station_id = v_a2 and o.deleted_at is null);
    v_linked := found;
  end if;

  return pg_catalog.jsonb_build_object('saved', v_n, 'replaced', v_taken, 'station_given_id', v_linked);
end
$$;

-- tdma_site_save: change a site everywhere it appears — its name, its ALERT2
-- ID, its register station — across every channel.
--   { match_site, match_alert2_id (null for a site with none), site, alert2_id, station_id }
create or replace function meganet.tdma_site_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  text := meganet.actor();
  v_key    text;
  v_msite  text;
  v_ma2    integer;
  v_site   text;
  v_a2     integer;
  v_st     text;
  v_n      integer;
  v_linked boolean := false;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to change the slot table'
      using errcode = '42501', hint = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'meganet.tdma_site_save() needs a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('match_site', 'match_alert2_id', 'site', 'alert2_id', 'station_id') then
      raise exception 'meganet.tdma_site_save() does not take %', v_key using errcode = '22023',
        hint = 'match_site, match_alert2_id, site, alert2_id and station_id are the whole list';
    end if;
  end loop;
  begin
    v_ma2 := nullif(p ->> 'match_alert2_id', '')::integer;
    v_a2  := nullif(p ->> 'alert2_id', '')::integer;
  exception when others then
    raise exception 'an ALERT2 ID is a number' using errcode = '22023';
  end;
  v_msite := nullif(pg_catalog.btrim(p ->> 'match_site'), '');
  v_site  := nullif(pg_catalog.btrim(p ->> 'site'), '');
  v_st    := nullif(pg_catalog.btrim(p ->> 'station_id'), '');
  if v_msite is null or v_site is null then
    raise exception 'a site needs a name' using errcode = '22023';
  end if;
  if v_a2 is not null and (v_a2 < 1 or v_a2 > 65534) then
    raise exception 'an ALERT2 ID is 1–65534' using errcode = '22023';
  end if;
  if v_st is not null and not exists (select 1 from meganet.station where id = v_st and deleted_at is null) then
    raise exception 'no station % in the register', v_st using errcode = '22023';
  end if;

  update meganet.tdma_slot s
     set site = v_site, alert2_id = v_a2, station_id = v_st, updated_at = pg_catalog.now(), updated_by = v_actor
   where s.site = v_msite and s.alert2_id is not distinct from v_ma2;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'no slot on file is held by % (%)', v_msite, coalesce(v_ma2::text, 'no ALERT2 ID')
      using errcode = 'PT409', hint = 'somebody may have changed it first: reload the slot table';
  end if;

  if v_st is not null and v_a2 is not null then
    update meganet.station st set alert2_station_id = v_a2
     where st.id = v_st and st.alert2_station_id is null
       and not exists (select 1 from meganet.station o where o.alert2_station_id = v_a2 and o.deleted_at is null);
    v_linked := found;
  end if;
  return pg_catalog.jsonb_build_object('saved', v_n, 'station_given_id', v_linked);
end
$$;

-- tdma_slot_remove: make a run of slots spare again.
create or replace function meganet.tdma_slot_remove(p_freq numeric, p_slot numeric, p_slots integer default 1)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot numeric;
  v_n    integer;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to change the slot table'
      using errcode = '42501', hint = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  select c.slot_s into v_slot from meganet.tdma_channel c where c.freq_mhz = p_freq;
  if v_slot is null then
    raise exception 'no channel % MHz on file', p_freq using errcode = '22023';
  end if;
  delete from meganet.tdma_slot s
   where s.freq_mhz = p_freq and s.slot_s >= p_slot
     and s.slot_s <= p_slot + (greatest(coalesce(p_slots, 1), 1) - 1) * v_slot;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke all on function meganet.tdma_slot_save(jsonb)                     from public;
revoke all on function meganet.tdma_site_save(jsonb)                     from public;
revoke all on function meganet.tdma_slot_remove(numeric, numeric, integer) from public;
revoke all on function meganet.tdma_heard(integer)                       from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.tdma_channel, meganet.tdma_slot to anon, authenticated;
  grant select, insert, update, delete on meganet.tdma_channel, meganet.tdma_slot to service_role;
  grant execute on function meganet.tdma_heard(integer) to anon, authenticated, service_role;
  grant execute on function meganet.tdma_slot_save(jsonb)                       to authenticated, service_role;
  grant execute on function meganet.tdma_site_save(jsonb)                       to authenticated, service_role;
  grant execute on function meganet.tdma_slot_remove(numeric, numeric, integer) to authenticated, service_role;
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from meganet.tdma_channel) < 4 then
    raise exception '0120 did not take: fewer than four channels';
  end if;
  if (select count(*) from meganet.tdma_slot) < 151 then
    raise exception '0120 did not take: % slots on file, the sheet has 151', (select count(*) from meganet.tdma_slot);
  end if;
  if exists (select 1 from meganet.tdma_slot where freq_mhz = 151.5375 and slot_s = 0 and alert2_id is distinct from 11058) then
    raise exception '0120 did not take: slot 0 on 151.5375 MHz is not Fords Rd Reserve (11058)';
  end if;
end
$$;

-- DB_SCHEMA_VERSION in core.js goes 119 → 120 in the same commit.
insert into meganet.app_meta (key, value)
values ('schema_version', '120')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
