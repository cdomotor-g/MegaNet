-- 0103_rx_threshold.sql — The field station receiver's threshold goes from
-- −117 dBm to −110 dBm.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0103_rx_threshold.sql
--
-- Why this file exists
-- ────────────────────
-- Every station in the register is on a radio system, meganet.rm_system, and
-- every fade margin the app prices — the link budget card, the fade-margin map,
-- the site finder, the Network Review tab, the agent API's radio paths — is the
-- received level less that system's rx_threshold_dbm. Both real systems,
-- Field Station 1W (every station) and Field Station 5W, carried −117.001 dBm,
-- the figure the Radio Mobile network file came with. The owner's call
-- (5 November 2026): the default receiver sensitivity is −110 dBm across the
-- board — the figure the Radio Mobile runs done for the Bureau use
-- (docs/network-review.md, "One path, side by side"). Every margin on these
-- two systems reads 7 dB less from here.
--
-- The field model's allowance (core.js FN_MODEL_DEFAULTS, 12 dB) was fitted
-- against the attenuator tests at the old threshold. It is left as it is: the
-- Network Review tab's history check re-fits it on demand, and whether to take
-- the new fit up is the owner's to say.
--
-- Only rows still on the old figure move, so a threshold somebody has set
-- since is left alone, and re-running this changes nothing. stations.json and
-- the Radio Mobile export (radio-mobile/MegaNet_System.csv) move in the same
-- commit, so a reload of the stations doc (load_stations_doc) does not put
-- −117.001 back.

update meganet.rm_system
   set rx_threshold_dbm = -110,
       updated_at       = now(),
       updated_by       = '0103_rx_threshold'
 where id in (1, 2)
   and rx_threshold_dbm = -117.001;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from meganet.rm_system
              where id in (1, 2) and rx_threshold_dbm = -117.001) then
    raise exception '0103 did not take: a field station system is still at -117.001 dBm';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 103 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '103')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
