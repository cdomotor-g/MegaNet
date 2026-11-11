-- 0115_base_station_names.sql — Base stations by the names people call them,
-- for anybody: "18 Bateson", not "rpi-83071968".
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0115_base_station_names.sql
--
-- Why this file exists
-- ────────────────────
-- A reading's path names the receiver that took it in —
-- "serial-monitor/rpi-83071968-sdr1-151.5375" — which nobody says aloud. Each
-- receiver says whose it is when it checks in (meganet.ingest_point_report,
-- 0045): the base station's name is its ingest token's label. That table is
-- the editors' to read, because it also holds where the receiver is and what
-- it is made of, so only a signed-in editor's Message Log could say "18
-- Bateson", and the agent API's /readings/heard — written for somebody
-- following their own base station — had to be asked for a code.
--
-- The owner's decision (11 November 2026): the names are public. A reading's
-- path is public already, so the receiver's code is; this adds the name beside
-- it and nothing more.
--
-- What it publishes
-- ─────────────────
-- meganet.base_station_name, one row a receiver:
--
--   name          the base station's name — its ingest token's label, as the
--                 receiver's newest report carries it;
--   receiver      the receiver as a reading's path names it without the stick
--                 and frequency: 'serial-monitor/rpi-83071968';
--   station_id    the station of the register it stands at, where on file —
--                 the register is public;
--   last_seen_at  when any of its sticks last checked in.
--
-- One base station can be several rows: a Pi that was replaced keeps the
-- readings it took in, and they are still that base station's.
--
-- What it does not: the receiver's position, how that was got, its hardware
-- detail, the token's id. Those stay the editors'.

create or replace view meganet.base_station_name as
select distinct on (receiver)
       name, receiver, station_id, last_seen_at
  from (select pg_catalog.btrim(p.token_label) as name,
               'serial-monitor/' || pg_catalog.regexp_replace(p.point_id, '-sdr\d+(-[\d.]+)?$', '') as receiver,
               p.host_station_id as station_id,
               pg_catalog.max(p.last_seen_at) over (
                 partition by pg_catalog.regexp_replace(p.point_id, '-sdr\d+(-[\d.]+)?$', '')) as last_seen_at,
               p.reported_at,
               p.id
          from meganet.ingest_point_report p
         where pg_catalog.btrim(coalesce(p.token_label, '')) <> ''
           and pg_catalog.btrim(coalesce(p.point_id, '')) <> '') x
 order by receiver, reported_at desc, id desc;

comment on view meganet.base_station_name is
  'Base stations by name, for anybody (0115): one row a receiver — the name (its ingest token''s label on the receiver''s newest report), the receiver as a reading''s path names it without the stick and frequency (''serial-monitor/rpi-83071968''), the register station it stands at where on file, and when it last checked in. Deliberately not security_invoker, as 0102''s station_benchmark_public is not: what it carries is fixed here and checked below. No position, no hardware detail, no token id: those are meganet.ingest_point_report''s, for editors.';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.base_station_name to anon, authenticated, service_role;
  revoke insert, update, delete, truncate on meganet.base_station_name from anon, authenticated;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
declare
  v_cols text;
begin
  if pg_catalog.to_regclass('meganet.base_station_name') is null then
    raise exception '0115 did not take: meganet.base_station_name is missing';
  end if;
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'meganet.base_station_name'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'name,receiver,station_id,last_seen_at' then
    raise exception '0115 did not take: the view publishes % — only name, receiver, station_id and last_seen_at may be public', v_cols;
  end if;
  if exists (select 1 from meganet.base_station_name group by receiver having count(*) > 1) then
    raise exception '0115 did not take: a receiver has more than one name';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    if not pg_catalog.has_table_privilege('anon', 'meganet.base_station_name', 'select') then
      raise exception '0115 did not take: anon cannot read meganet.base_station_name';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.base_station_name', 'insert,update,delete') then
      raise exception '0115 did not take: anon can write meganet.base_station_name';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.ingest_point_report', 'select')
       and not exists (select 1 from pg_catalog.pg_class c
                        where c.oid = 'meganet.ingest_point_report'::regclass and c.relrowsecurity) then
      raise exception '0115 did not take: the receivers'' own reports are open to anon';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 115 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '115')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
