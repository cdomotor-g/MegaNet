-- check_health_cards.sql — Prove 0085: each station as Station Health shows
-- it, kept for the agent API. What the run reports a batch at a time is kept,
-- rewritten only when it changed, forgotten when a complete run no longer
-- heard the station (and only then); a batch from an older run is refused;
-- everybody reads, and nobody but the secret key writes.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_health_cards.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database.

\set ON_ERROR_STOP on

begin;

create temporary table _check (
  ord   serial,
  name  text,
  ok    boolean,
  note  text
) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

-- One statement as another role: its first column as text, or
-- 'ERROR <sqlstate>'. Rolled back.
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- The run reporting, kept: the secret key is service_role.
create or replace function pg_temp.report(p_report jsonb)
returns jsonb language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';
  execute pg_catalog.format('select meganet.report_station_cards(%L::jsonb)::text', p_report) into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v::jsonb;
end;
$$;

-- A card as tools/health/cards.mjs makes it.
create or replace function pg_temp.card(p_id text, p_worst text, p_title text default 'Silent — missed its last 4 checks')
returns jsonb language sql immutable as $$
  select pg_catalog.jsonb_build_object(
    'station_id', p_id,
    'status', coalesce(p_worst, 'ok'),
    'worst', p_worst,
    'findings', case when p_worst is null then 0 else 1 end,
    'attention', case when p_worst in ('critical', 'warn') then 1 else 0 end,
    'card', pg_catalog.jsonb_build_object('v', 1, 'station_id', p_id, 'name', p_id,
      'findings', case when p_worst is null then '[]'::jsonb
                       else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'silent', 'severity', p_worst, 'title', p_title)) end,
      'schedule', pg_catalog.jsonb_build_object('every_minutes', 180, 'daily', '[]'::jsonb),
      'battery', null));
$$;

do $$
declare
  r      jsonb;
  t1     timestamptz := now() - interval '30 minutes';
  t2     timestamptz := now() - interval '15 minutes';
  heard  jsonb := '["_chk_a", "_chk_b", "_chk_c"]'::jsonb;
  v_was  timestamptz;
begin
  -- Nothing left over from a live database's own cards decides a check.
  delete from meganet.health_card;
  delete from meganet.health_card_run;

  -- ── Who may ──
  perform pg_temp.check_that('the tables exist, with RLS on',
    (select bool_and(relrowsecurity) from pg_class
      where oid in ('meganet.health_card'::regclass, 'meganet.health_card_run'::regclass)));
  perform pg_temp.check_that('anon and a signed-in account cannot report cards',
    pg_temp.as_role('anon', '{"role":"anon"}', 'select meganet.report_station_cards(''{}''::jsonb)::text') = 'ERROR 42501'
      and pg_temp.as_role('authenticated', '{"role":"authenticated"}', 'select meganet.report_station_cards(''{}''::jsonb)::text') = 'ERROR 42501');
  perform pg_temp.check_that('…nor write a card or a run straight into the tables',
    pg_temp.as_role('anon', '{"role":"anon"}', $q$insert into meganet.health_card (days, station_id, card, changed_at) values (7, 'x', '{}', now()) returning 'inserted'$q$) like 'ERROR %'
      and pg_temp.as_role('authenticated', '{"role":"authenticated"}', $q$insert into meganet.health_card_run (days, at) values (7, now()) returning 'inserted'$q$) like 'ERROR %');

  -- ── A run, in two batches ──
  r := pg_temp.report(jsonb_build_object('at', t1, 'days', 7, 'complete', true, 'heard', heard,
         'detail', jsonb_build_object('readings', 1000, 'stations', 3),
         'cards', jsonb_build_array(pg_temp.card('_chk_a', 'critical'), pg_temp.card('_chk_b', null))));
  perform pg_temp.check_that('a batch is kept, and says how many it wrote',
    (r ->> 'upserted')::int = 2 and (r ->> 'unchanged')::int = 0
      and (select count(*) from meganet.health_card where days = 7) = 2, r::text);
  r := pg_temp.report(jsonb_build_object('at', t1, 'days', 7, 'complete', true, 'heard', heard,
         'cards', jsonb_build_array(pg_temp.card('_chk_c', 'warn'))));
  perform pg_temp.check_that('the run''s next batch (the same at) is taken too, and forgets none of the first',
    (r ->> 'upserted')::int = 1 and (r ->> 'removed')::int = 0
      and (select count(*) from meganet.health_card where days = 7) = 3, r::text);
  perform pg_temp.check_that('a card keeps its worst severity and counts beside it, and the run when it changed',
    (select worst = 'critical' and status = 'critical' and findings = 1 and attention = 1 and changed_at = t1
       and card ->> 'station_id' = '_chk_a'
       from meganet.health_card where days = 7 and station_id = '_chk_a')
      and (select worst is null and findings = 0 and attention = 0 from meganet.health_card where days = 7 and station_id = '_chk_b'));
  perform pg_temp.check_that('the run is recorded, with what it said about itself',
    (select at = t1 and (detail ->> 'readings')::int = 1000 and (detail ->> 'complete')::boolean
       from meganet.health_card_run where days = 7));

  -- ── The next run ──
  r := pg_temp.report(jsonb_build_object('at', t2, 'days', 7, 'complete', true, 'heard', '["_chk_a", "_chk_b"]'::jsonb,
         'cards', jsonb_build_array(pg_temp.card('_chk_a', 'critical'), pg_temp.card('_chk_b', 'info', 'Went silent, then came back'))));
  perform pg_temp.check_that('a card that has not changed is not rewritten; one that has is',
    (r ->> 'upserted')::int = 1 and (r ->> 'unchanged')::int = 1
      and (select changed_at = t1 from meganet.health_card where days = 7 and station_id = '_chk_a')
      and (select changed_at = t2 and worst = 'info' from meganet.health_card where days = 7 and station_id = '_chk_b'), r::text);
  perform pg_temp.check_that('a complete run forgets the station it no longer heard',
    (r ->> 'removed')::int = 1 and not exists (select 1 from meganet.health_card where days = 7 and station_id = '_chk_c'), r::text);
  perform pg_temp.check_that('…and the run''s time moves on',
    (select at = t2 from meganet.health_card_run where days = 7));

  r := pg_temp.report(jsonb_build_object('at', now() - interval '10 minutes', 'days', 7, 'complete', false,
         'cards', jsonb_build_array(pg_temp.card('_chk_a', 'warn'))));
  perform pg_temp.check_that('a run that did not read everything updates, and forgets nobody',
    (r ->> 'removed')::int = 0 and (select count(*) from meganet.health_card where days = 7) = 2
      and (select worst = 'warn' from meganet.health_card where days = 7 and station_id = '_chk_a'), r::text);

  select at into v_was from meganet.health_card_run where days = 7;
  r := pg_temp.report(jsonb_build_object('at', t1, 'days', 7, 'complete', true, 'heard', '[]'::jsonb,
         'cards', jsonb_build_array(pg_temp.card('_chk_a', 'critical'))));
  perform pg_temp.check_that('a batch from an older run is refused, and changes nothing',
    (r ->> 'stale')::boolean and (select worst = 'warn' from meganet.health_card where days = 7 and station_id = '_chk_a')
      and (select count(*) from meganet.health_card where days = 7) = 2
      and (select at = v_was from meganet.health_card_run where days = 7), r::text);

  r := pg_temp.report(jsonb_build_object('at', t1, 'days', 14, 'complete', true, 'heard', '["_chk_a"]'::jsonb,
         'cards', jsonb_build_array(pg_temp.card('_chk_a', 'info'))));
  perform pg_temp.check_that('each window is its own: a fortnight''s run neither refused by the week''s nor touching its cards',
    (r ->> 'upserted')::int = 1 and (select count(*) from meganet.health_card where days = 7) = 2
      and (select worst = 'info' from meganet.health_card where days = 14 and station_id = '_chk_a'), r::text);

  -- ── What it refuses ──
  perform pg_temp.check_that('a window the tab does not have is refused',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'days', 5, 'cards', '[]'::jsonb))) = 'ERROR 22023');
  perform pg_temp.check_that('…and a card with no station, a severity it does not know, or no card at all',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'days', 7, 'cards', jsonb_build_array(pg_temp.card('', 'warn'))))) = 'ERROR 22023'
      and pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'days', 7, 'cards', jsonb_build_array(pg_temp.card('_chk_x', 'dire'))))) = 'ERROR 22023'
      and pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'days', 7, 'cards', jsonb_build_array(pg_temp.card('_chk_x', 'warn') - 'card')))) = 'ERROR 22023');
  perform pg_temp.check_that('…and a complete report that does not say which stations it heard',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'days', 7, 'complete', true, 'cards', '[]'::jsonb))) = 'ERROR 22023');
  perform pg_temp.check_that('…and a card over 32 KB',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'days', 7, 'cards', jsonb_build_array(
        jsonb_set(pg_temp.card('_chk_x', 'warn'), '{card,pad}', to_jsonb(repeat('x', 33000))))))) = 'ERROR 22023');
  perform pg_temp.check_that('…and a report from the future, or more than a day old',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now() + interval '1 hour', 'days', 7, 'cards', '[]'::jsonb))) = 'ERROR 22023'
      and pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_cards(%L::jsonb)::text',
      jsonb_build_object('at', now() - interval '2 days', 'days', 7, 'cards', '[]'::jsonb))) = 'ERROR 22023');

  -- ── Who reads ──
  perform pg_temp.check_that('anon reads the cards and when each window last ran, as the agent API does',
    pg_temp.as_role('anon', '{"role":"anon"}', 'select count(*)::text from meganet.health_card') = '3'
      and pg_temp.as_role('anon', '{"role":"anon"}', 'select count(*)::text from meganet.health_card_run') = '2');
end
$$;

-- ── The verdict ─────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
