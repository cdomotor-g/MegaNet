-- 0122_mt_glorious_alert2.sql — Mt Glorious Primary and Secondary to their
-- stations, as the owner decided on 12 November 2026.
--
-- The slot sheet (0120) has Mt Glorious Primary on 173.9 MHz (ALERT2 ID 9511,
-- slots 0–9.5 s) and Mt Glorious Secondary on 173.95 MHz (9601, 10–19.5 s).
-- 0120 and 0121 left them unlinked, because the register has three stations on
-- the hill: the repeater (Mt Glorious AL RPTR) and the primary and backup
-- gauges. The owner's answer: Primary is Mt Glorious AL-P, Secondary is
-- Mt Glorious AL-B.
--
-- Only an unlinked slot and a station with no ALERT2 ID are touched, so an
-- editor's later choice stands. Idempotent and forward-only.

update meganet.tdma_slot t
   set station_id = v.st, updated_at = pg_catalog.now(), updated_by = '0122'
  from (values (9511, 'Mt Glorious Primary', 'mt_glorious_al_p'),
               (9601, 'Mt Glorious Secondary', 'mt_glorious_al_b')) as v (a2, site, st)
 where t.alert2_id = v.a2 and t.site = v.site and t.station_id is null
   and exists (select 1 from meganet.station s where s.id = v.st and s.deleted_at is null);

update meganet.station st
   set alert2_station_id = v.a2, updated_by = '0122'
  from (values (9511, 'mt_glorious_al_p'), (9601, 'mt_glorious_al_b')) as v (a2, id)
 where st.id = v.id and st.deleted_at is null and st.alert2_station_id is null
   and not exists (select 1 from meganet.station o where o.alert2_station_id = v.a2 and o.deleted_at is null);

do $$
begin
  if exists (select 1 from meganet.station where id = 'mt_glorious_al_p' and deleted_at is null)
     and meganet.resolve_a2_sensor(9511, null) is distinct from 'mt_glorious_al_p' then
    raise exception '0122 did not take: 9511 resolves to %', coalesce(meganet.resolve_a2_sensor(9511, null), '(null)');
  end if;
  if exists (select 1 from meganet.station where id = 'mt_glorious_al_b' and deleted_at is null)
     and meganet.resolve_a2_sensor(9601, null) is distinct from 'mt_glorious_al_b' then
    raise exception '0122 did not take: 9601 resolves to %', coalesce(meganet.resolve_a2_sensor(9601, null), '(null)');
  end if;
end
$$;

-- DB_SCHEMA_VERSION in core.js goes 121 → 122 once this is applied.
insert into meganet.app_meta (key, value)
values ('schema_version', '122')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
