-- check_equipment_approve_all.sql — Prove 0093: two descriptions of one unit,
-- the decision rule that follows from it, approving what is waiting in one
-- call, and the repair of the retirements that were one unit recorded twice.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_equipment_approve_all.sql
--
-- Runs inside a transaction and rolls back, so it is safe against the live
-- database: the placeholder stations, photos, people, suggestions and units it
-- makes are gone at the end. Run as a role is_admin() says yes to — a direct
-- psql connection. Prints a row per check, exits non-zero if any failed. CI
-- runs it in the db-checks job beside tools/check_photo_review.sql, which
-- still proves the rest of 0036's rules.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

create or replace function pg_temp.state_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

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

create or replace function pg_temp.photo(p_station text, p_taken timestamptz)
returns uuid language plpgsql as $$
declare
  u text := gen_random_uuid()::text;
  v uuid;
begin
  v := (meganet.add_field_photo(jsonb_build_object(
          'storage_path', 'photo/' || u || '.jpg', 'thumb_path', 'photo/' || u || '.thumb.jpg',
          'content_type', 'image/jpeg', 'byte_size', 1000, 'sha256', encode(sha256(convert_to(u, 'UTF8')), 'hex'),
          'title', 'IMG.jpg', 'station_id', p_station)) ->> 'id')::uuid;
  update meganet.field_photo set taken_at = p_taken where id = v;
  return v;
end;
$$;

-- A suggestion as the photo reader makes one.
create or replace function pg_temp.sug(p_photo uuid, p_kind text, p_make text, p_model text, p_serial text, p_conf numeric)
returns uuid language sql as $$
  select (meganet.propose_equipment(jsonb_strip_nulls(jsonb_build_object(
            'photo_id', p_photo, 'equipment_key', p_kind, 'make', p_make, 'model', p_model, 'serial_no', p_serial,
            'confidence', p_conf, 'evidence', 'check_equipment_approve_all', 'proposed_by', 'agent:photo-reader'))) ->> 'id')::uuid;
$$;

create or replace function pg_temp.live(p_station text, p_kind text)
returns integer language sql as $$
  select count(*)::integer from meganet.station_equipment where station_id = p_station and equipment_key = p_kind and retired_at is null;
$$;

insert into meganet.rm_system (id, ord, name) values (-993, -993, 'check_equipment_approve_all placeholder')
on conflict (id) do nothing;
insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon) values
  ('_check_aa_a', -993, 'Check AA A', '998930', -993, -32.5, 161.0),
  ('_check_aa_b', -994, 'Check AA B', '998931', -993, -32.6, 161.1),
  ('_check_aa_c', -995, 'Check AA C', '998932', -993, -32.7, 161.2),
  ('_check_aa_d', -996, 'Check AA D', '998933', -993, -32.8, 161.3),
  ('_check_aa_e', -997, 'Check AA E', '998934', -993, -32.9, 161.4)
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values ('aa-editor@example.test', 'check_equipment_approve_all — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000aa001', 'aa-editor@example.test', now())
on conflict (id) do nothing;

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('editor', '{"role":"authenticated","email":"aa-editor@example.test","sub":"00000000-0000-4000-8000-0000000aa001"}');

create temporary table _ids (k text primary key, id uuid) on commit drop;

-- ── 1. Landed ────────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 93',
    (select value::integer >= 93 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('the bulk approval and the repair are security definer with an empty search_path',
    (select count(*) = 2 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
       from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet' and p.proname in ('approve_equipment_suggestions', 'repair_same_unit_retirements')));
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('an administrator''s browser may approve in bulk; only the service key repairs; public holds neither',
      has_function_privilege('authenticated', 'meganet.approve_equipment_suggestions(jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.repair_same_unit_retirements()', 'execute')
      and has_function_privilege('service_role', 'meganet.repair_same_unit_retirements()', 'execute')
      and not has_function_privilege('public', 'meganet.approve_equipment_suggestions(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.approve_equipment_suggestions(jsonb)', 'execute'));
  end if;
end
$$;

-- ── 2. Two descriptions of one unit ──────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('a make alone, and a make that is the start of another, are one unit',
    meganet.equipment_compatible('Victron Energy', 'SmartSolar MPPT 75/15', 'HQ1', 'Victron', '', '')
    and meganet.equipment_compatible('Kisters', 'WL3100', 'K-1', 'KISTERS', '', '')
    and meganet.equipment_compatible('', 'TB3', '', 'HyQuest Solutions', 'tb 3', 'T1'));
  perform pg_temp.check_that('another model, another serial or another make is another unit',
    not meganet.equipment_compatible('Campbell Scientific', 'CR300', '', 'Campbell Scientific', 'CR3000', '')
    and not meganet.equipment_compatible('', '', 'A1', '', '', 'A2')
    and not meganet.equipment_compatible('Invicta', 'SNL12V12S', '', 'GIC', '', ''));
end
$$;

-- ── 3. One at a time: a sighting with less in it is the same unit ────────────

do $$
declare
  p1 uuid := pg_temp.photo('_check_aa_a', '2026-03-30 09:00+10');
  p2 uuid := pg_temp.photo('_check_aa_a', '2026-03-30 09:05+10');
  s uuid;
  v_out jsonb;
  v_unit uuid;
begin
  -- The bubbler known by its model and serial; then a photo showing only the make.
  s := pg_temp.sug(p1, 'bubble_unit', 'Kisters', 'WL3100', 'K-1', 0.9);
  v_unit := (meganet.decide_equipment_suggestion(s, 'approve') -> 'equipment' ->> 'id')::uuid;
  s := pg_temp.sug(p2, 'bubble_unit', 'Kisters', null, null, 0.8);
  v_out := meganet.decide_equipment_suggestion(s, 'approve');
  perform pg_temp.check_that('a photo of only the make is the unit seen again: the same row, model and serial kept, nothing retired',
    (v_out -> 'equipment' ->> 'id')::uuid = v_unit and v_out -> 'retired' = '[]'::jsonb
    and v_out -> 'equipment' ->> 'model' = 'WL3100' and v_out -> 'equipment' ->> 'serial_no' = 'K-1', v_out::text);

  -- A regulator known by its make alone; then its model read.
  s := pg_temp.sug(p1, 'solar_regulator', 'Victron Energy', null, null, 0.8);
  v_unit := (meganet.decide_equipment_suggestion(s, 'approve') -> 'equipment' ->> 'id')::uuid;
  s := pg_temp.sug(p2, 'solar_regulator', 'Victron Energy', 'SmartSolar MPPT 75/15', null, 0.9);
  v_out := meganet.decide_equipment_suggestion(s, 'approve');
  perform pg_temp.check_that('a model read for a unit known by its make fills it in — the same row, nothing retired',
    (v_out -> 'equipment' ->> 'id')::uuid = v_unit and v_out -> 'equipment' ->> 'model' = 'SmartSolar MPPT 75/15'
    and v_out -> 'retired' = '[]'::jsonb, v_out::text);

  -- Two different things filed as other.
  s := pg_temp.sug(p1, 'other', 'Invicta', 'SNL12V12S', null, 0.8);
  perform meganet.decide_equipment_suggestion(s, 'approve');
  s := pg_temp.sug(p2, 'other', 'GIC', null, null, 0.8);
  v_out := meganet.decide_equipment_suggestion(s, 'approve');
  perform pg_temp.check_that('an other is never taken to replace another other: added alongside',
    v_out -> 'retired' = '[]'::jsonb and pg_temp.live('_check_aa_a', 'other') = 2, v_out::text);

  -- Still a replacement: another model of logger.
  s := pg_temp.sug(p1, 'logger', 'Campbell Scientific', 'CR300', '111', 0.9);
  v_unit := (meganet.decide_equipment_suggestion(s, 'approve') -> 'equipment' ->> 'id')::uuid;
  s := pg_temp.sug(p2, 'logger', 'Campbell Scientific', 'CR310', '222', 0.9);
  v_out := meganet.decide_equipment_suggestion(s, 'approve');
  perform pg_temp.check_that('another model of the one logger there is still a replacement — the old one retired',
    v_out -> 'retired' = jsonb_build_array(v_unit) and pg_temp.live('_check_aa_a', 'logger') = 1, v_out::text);
end
$$;

-- ── 4. All at once ───────────────────────────────────────────────────────────

do $$
declare
  p1 uuid := pg_temp.photo('_check_aa_c', '2026-04-21 10:00+10');
  p2 uuid := pg_temp.photo('_check_aa_c', '2026-04-21 10:10+10');
  p3 uuid := pg_temp.photo('_check_aa_c', '2026-04-21 10:20+10');
  q1 uuid := pg_temp.photo('_check_aa_d', '2026-05-01 10:00+10');
  q2 uuid := pg_temp.photo('_check_aa_d', '2026-05-01 10:10+10');
  v_out jsonb;
  v text;
  s_low uuid;
  s_make uuid;
begin
  -- Station C: two rain gauges, a make-only and a model-only sighting that
  -- could be either, two different others, and a panel the reader was unsure of.
  perform pg_temp.sug(p1, 'tbrg', 'HyQuest Solutions', 'TB3', 'T-1', 0.9);
  perform pg_temp.sug(p2, 'tbrg', 'HyQuest Solutions', 'TB3', 'T-2', 0.9);
  s_make := pg_temp.sug(p3, 'tbrg', 'HyQuest Solutions', null, null, 0.8);
  perform pg_temp.sug(p3, 'tbrg', null, 'TB3', null, 0.7);
  perform pg_temp.sug(p1, 'other', 'Invicta', 'SNL12V12S', null, 0.8);
  perform pg_temp.sug(p2, 'other', 'GIC', 'surge arrester', null, 0.8);
  s_low := pg_temp.sug(p3, 'solar_panel', 'Solarex', null, null, 0.3);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    $q$select meganet.approve_equipment_suggestions('{}')::text$q$);
  perform pg_temp.check_that('an editor who is not an administrator cannot approve in bulk', v = 'ERROR 42501', v);
  perform pg_temp.check_that('a key it does not take, and a confidence outside 0 to 1, are refused',
    pg_temp.state_of($q$select meganet.approve_equipment_suggestions('{"station":"x"}')$q$) = '22023'
    and pg_temp.state_of($q$select meganet.approve_equipment_suggestions('{"min_confidence":2}')$q$) = '22023');

  v_out := meganet.approve_equipment_suggestions('{"station_id":"_check_aa_c","min_confidence":0.5}');
  perform pg_temp.check_that('one station''s, at least half sure: two gauges and two others added, alongside each other',
    (v_out ->> 'approved')::int = 4 and (v_out ->> 'added')::int = 4 and (v_out ->> 'merged')::int = 0
    and pg_temp.live('_check_aa_c', 'tbrg') = 2 and pg_temp.live('_check_aa_c', 'other') = 2, v_out::text);
  perform pg_temp.check_that('…nothing retired',
    not exists (select 1 from meganet.station_equipment where station_id = '_check_aa_c' and retired_at is not null));
  perform pg_temp.check_that('…the sightings that could be either gauge left waiting, saying so',
    jsonb_array_length(v_out -> 'left') = 2 and (v_out -> 'left' -> 0 ->> 'why') like 'it could be any of 2 %'
    and (select status from meganet.equipment_suggestion where id = s_make) = 'pending', v_out::text);
  perform pg_temp.check_that('…the panel the reader was unsure of left alone, and nothing more to do at that confidence',
    (select status from meganet.equipment_suggestion where id = s_low) = 'pending' and (v_out ->> 'remaining')::int = 0, v_out::text);
  perform pg_temp.check_that('…each approval through the one door, with its note and the reader as the source',
    (select bool_and(s.status = 'approved' and s.decision_note = 'Approved with the others waiting, in one go')
       from meganet.equipment_suggestion s where s.station_id = '_check_aa_c' and s.equipment_key = 'tbrg' and s.serial_no <> '')
    and (select bool_and(source = 'agent') from meganet.station_equipment where station_id = '_check_aa_c'));

  -- Station D: one gauge read three ways and its serial read twice.
  perform pg_temp.sug(q1, 'tbrg', 'HyQuest Solutions', 'TB3', 'X-9', 0.9);
  perform pg_temp.sug(q2, 'tbrg', 'HyQuest Solutions', 'TB3', 'X 9', 0.85);
  perform pg_temp.sug(q2, 'tbrg', 'HyQuest Solutions', null, null, 0.8);
  perform pg_temp.sug(q1, 'tbrg', null, 'TB3', null, 0.7);
  v_out := meganet.approve_equipment_suggestions('{"ids":[]}');
  perform pg_temp.check_that('an empty list of ids approves nothing', (v_out ->> 'approved')::int = 0, v_out::text);
  v_out := meganet.approve_equipment_suggestions(jsonb_build_object('station_id', '_check_aa_d', 'note', 'baseline'));
  perform pg_temp.check_that('one gauge read four ways is one unit: added once, the serial''s twin superseded, the others merged into it',
    (v_out ->> 'added')::int = 1 and (v_out ->> 'merged')::int = 2 and (v_out ->> 'superseded')::int = 1
    and pg_temp.live('_check_aa_d', 'tbrg') = 1
    and (select serial_no = 'X-9' and model = 'TB3' from meganet.station_equipment
          where station_id = '_check_aa_d' and equipment_key = 'tbrg' and retired_at is null), v_out::text);
  perform pg_temp.check_that('…with the note given',
    (select bool_and(decision_note = 'baseline') from meganet.equipment_suggestion
      where station_id = '_check_aa_d' and status = 'approved'));
end
$$;

-- ── 5. The repair ────────────────────────────────────────────────────────────

do $$
declare
  d1 uuid := pg_temp.photo('_check_aa_e', '2026-04-21 10:00+10');
  d2 uuid := pg_temp.photo('_check_aa_e', '2026-04-21 10:30+10');
  d3 uuid := pg_temp.photo('_check_aa_e', '2026-06-01 10:30+10');
  o_kis uuid; n_kis uuid; o_inv uuid; n_gic uuid; o_cr uuid; n_cr uuid; o_far uuid; n_far uuid;
  v_out jsonb;
  v text;
begin
  -- Wrong retirements as 0036's rule 4 made them, written as they were left.
  insert into meganet.station_equipment (station_id, equipment_key, make, serial_no, source, photo_id, created_by)
    values ('_check_aa_e', 'bubble_unit', 'Kisters', '', 'agent', d2, 'x') returning id into n_kis;
  insert into meganet.station_equipment (station_id, equipment_key, make, model, serial_no, source, photo_id, created_by, retired_at, retired_by, replaced_by)
    values ('_check_aa_e', 'bubble_unit', 'Kisters', 'WL3100', 'K-9', 'agent', d1, 'x', now(), 'x', n_kis) returning id into o_kis;
  insert into meganet.station_equipment (station_id, equipment_key, make, source, photo_id, created_by)
    values ('_check_aa_e', 'other', 'GIC', 'agent', d2, 'x') returning id into n_gic;
  insert into meganet.station_equipment (station_id, equipment_key, make, model, source, photo_id, created_by, retired_at, retired_by, replaced_by)
    values ('_check_aa_e', 'other', 'Invicta', 'SNL12V12S', 'agent', d1, 'x', now(), 'x', n_gic) returning id into o_inv;
  -- A real replacement, the same day: another model.
  insert into meganet.station_equipment (station_id, equipment_key, make, model, serial_no, source, photo_id, created_by)
    values ('_check_aa_e', 'logger', 'Campbell Scientific', 'CR310', '2', 'agent', d2, 'x') returning id into n_cr;
  insert into meganet.station_equipment (station_id, equipment_key, make, model, serial_no, source, photo_id, created_by, retired_at, retired_by, replaced_by)
    values ('_check_aa_e', 'logger', 'Campbell Scientific', 'CR300', '1', 'agent', d1, 'x', now(), 'x', n_cr) returning id into o_cr;
  -- One that agrees, but off photos weeks apart: a swap for the same model is possible.
  insert into meganet.station_equipment (station_id, equipment_key, make, source, photo_id, created_by)
    values ('_check_aa_e', 'solar_regulator', 'Victron Energy', 'agent', d3, 'x') returning id into n_far;
  insert into meganet.station_equipment (station_id, equipment_key, make, model, source, photo_id, created_by, retired_at, retired_by, replaced_by)
    values ('_check_aa_e', 'solar_regulator', 'Victron Energy', 'BlueSolar MPPT 75/15', 'agent', d1, 'x', now(), 'x', n_far) returning id into o_far;

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select meganet.repair_same_unit_retirements()::text');
  perform pg_temp.check_that('nobody but the service key and the owner may run the repair', v like 'ERROR %', v);

  v_out := meganet.repair_same_unit_retirements();
  perform pg_temp.check_that('the repair: one unit recorded twice merged, one other put back, nothing skipped',
    (v_out ->> 'merged')::int = 1 and (v_out ->> 'put_back')::int = 1 and (v_out ->> 'skipped')::int = 0, v_out::text);
  perform pg_temp.check_that('…the live bubbler has the model and serial the retired row knew, and the retired row says why',
    (select model = 'WL3100' and serial_no = 'K-9' and retired_at is null from meganet.station_equipment where id = n_kis)
    and (select note like 'Recorded twice:%' and retired_at is not null from meganet.station_equipment where id = o_kis));
  perform pg_temp.check_that('…the other is back, both there',
    (select retired_at is null and replaced_by is null and retired_by is null from meganet.station_equipment where id = o_inv)
    and pg_temp.live('_check_aa_e', 'other') = 2);
  perform pg_temp.check_that('…a real replacement left alone, and one off photos weeks apart left alone',
    (select retired_at is not null and replaced_by = n_cr from meganet.station_equipment where id = o_cr)
    and (select retired_at is not null and note = '' from meganet.station_equipment where id = o_far)
    and (select model = '' from meganet.station_equipment where id = n_far));
  v_out := meganet.repair_same_unit_retirements();
  perform pg_temp.check_that('run again, it changes nothing',
    (v_out ->> 'merged')::int = 0 and (v_out ->> 'put_back')::int = 0, v_out::text);
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 200) end as detail
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
