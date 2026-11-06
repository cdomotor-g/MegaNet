-- 0105_field_station_25w.sql — A third field station radio system: 25 W.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0105_field_station_25w.sql
--
-- Why this file exists
-- ────────────────────
-- Every radio-system list in the app — the Repeater site finder, Polar radio
-- coverage, the station editor — offers the meganet.rm_system rows that carry
-- all four figures a fade margin needs (power, antenna gain, line loss, receiver
-- threshold). Only two did: Field Station 1W and Field Station 5W. The owner
-- asked (6 November 2026) for 25 W transmitters as well.
--
-- Slot 3 was "System 3", an empty placeholder the Radio Mobile network file
-- came with, with no station on it. It becomes Field Station 25W, so the Radio
-- Mobile export keeps its systems in order (1 W, 5 W, 25 W). Every figure but
-- the power is the other two systems' own: the 5.15 dBi omni, half a decibel
-- of line loss, the −110 dBm threshold (0103), and the 4 m mast most of the
-- network runs (path-profile.js PATH_DEFAULT_AGL). A station's own mast height
-- still wins wherever it has one on file.
--
-- Only a row still the empty placeholder moves, so a slot 3 somebody has filled
-- in since is left alone, and re-running this changes nothing. stations.json
-- and the Radio Mobile system file (radio-mobile/MegaNet_System.csv) move in
-- the same commit, so a reload of the stations doc (load_stations_doc) does not
-- put the placeholder back.

update meganet.rm_system
   set name             = 'Field Station 25W',
       tx_power_w       = 25,
       line_loss_db     = 0.5,
       supp_loss_db_m   = 0,
       antenna_type     = 'omni.ant',
       antenna_gain_dbi = 5.15,
       antenna_height_m = 4,
       rx_threshold_dbm = -110,
       updated_at       = now(),
       updated_by       = '0105_field_station_25w'
 where id = 3
   and name = 'System 3'
   and tx_power_w is null;

-- A register that never had a slot 3 gets one.
insert into meganet.rm_system (id, ord, name, tx_power_w, line_loss_db, supp_loss_db_m,
                               antenna_type, antenna_gain_dbi, antenna_height_m,
                               rx_threshold_dbm, updated_by)
select 3, coalesce((select max(ord) + 1 from meganet.rm_system), 0), 'Field Station 25W',
       25, 0.5, 0, 'omni.ant', 5.15, 4, -110, '0105_field_station_25w'
 where not exists (select 1 from meganet.rm_system where id = 3);

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from meganet.rm_system
                  where tx_power_w = 25 and antenna_gain_dbi is not null
                    and line_loss_db is not null and rx_threshold_dbm is not null) then
    raise exception '0105 did not take: no complete 25 W radio system (slot 3 was not the empty placeholder)';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 105 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '105')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
