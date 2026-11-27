-- tools/check_photo_upload.sql — the photo upload API's keys and receipts
-- (0127): minted by an administrator and shown once, checked by their hash,
-- one receipt per (key, photo), a daily allowance, the sender's hints checked
-- before anything is stored, a receipt seen only by its own key, settled once,
-- and nothing of it open to a browser.
--
-- Run after every migration and stations.json, as the CI job does:
--
--   psql -v ON_ERROR_STOP=1 -f tools/check_photo_upload.sql
--
-- Everything happens in one transaction and is rolled back.

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

-- Minting runs as the administrator, but the key it returns has to survive the
-- as_role rollback: so the mint is done here with the claims set, as postgres.
create or replace function pg_temp.mint(p_label text, p_day integer default 500)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"upload-admin@example.test","sub":"00000000-0000-4000-8000-0000000c0f02"}', true);
  v := meganet.admin_create_photo_upload_token(p_label, p_day);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

create or replace function pg_temp.hash(p_token text)
returns text language sql as $$
  select encode(sha256(convert_to(p_token, 'utf8')), 'hex');
$$;

create or replace function pg_temp.sha(p_seed text)
returns text language sql as $$
  select encode(sha256(convert_to(p_seed, 'utf8')), 'hex');
$$;

create or replace function pg_temp.offer(p_token_id bigint, p_seed text, p_hints jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select meganet.photo_upload_accept(p_token_id, jsonb_build_object(
    'sha256', pg_temp.sha(p_seed), 'file_name', 'IMG_' || p_seed || '.jpg',
    'content_type', 'image/jpeg', 'byte_size', 123456, 'hints', p_hints));
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────

insert into meganet.rm_system (id, ord, name)
values (-987, -987, 'check_photo_upload placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon) values
  ('_check_pu_a', -989, 'Check Upload A', '998370', -987, -31.5, 161.0)
on conflict (id) do nothing;

insert into meganet.editor_allow (entry, note) values
  ('upload-editor@example.test', 'check_photo_upload — rolled back'),
  ('upload-admin@example.test',  'check_photo_upload — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c0f01', 'upload-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000c0f02', 'upload-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000c0f02';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',    '{"role":"anon"}'),
  ('editor',  '{"role":"authenticated","email":"upload-editor@example.test","sub":"00000000-0000-4000-8000-0000000c0f01"}'),
  ('admin',   '{"role":"authenticated","email":"upload-admin@example.test","sub":"00000000-0000-4000-8000-0000000c0f02"}'),
  ('service', '{"role":"service_role"}');

create temporary table _keys (k text primary key, kv jsonb) on commit drop;
insert into _keys values ('acme', pg_temp.mint('Check Acme Surveys')),
                         ('tiny', pg_temp.mint('Check Tiny Allowance', 2));

-- ── Checks ───────────────────────────────────────────────────────────────────

do $$
declare
  v      text;
  acme   jsonb := (select kv from _keys where k = 'acme');
  tiny   jsonb := (select kv from _keys where k = 'tiny');
  aid    bigint := (acme ->> 'id')::bigint;
  tid    bigint := (tiny ->> 'id')::bigint;
  r1     jsonb;
  r2     jsonb;
  rx     jsonb;
  photo  uuid;
begin
  perform pg_temp.check_that('schema_version is at least 127',
    (select value::integer >= 127 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('both tables have RLS on',
    (select bool_and(relrowsecurity) from pg_catalog.pg_class
      where oid in (to_regclass('meganet.photo_upload_token'), to_regclass('meganet.photo_upload_receipt'))));

  -- Minting
  perform pg_temp.check_that('a minted key starts fnp_ and is 68 characters',
    acme ->> 'token' ~ '^fnp_[0-9a-f]{64}$', acme ->> 'token');
  perform pg_temp.check_that('only its hash is kept',
    (select token_hash = pg_temp.hash(acme ->> 'token') from meganet.photo_upload_token where id = aid)
    and not exists (select 1 from meganet.photo_upload_token where token_hash = acme ->> 'token'));
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
    'select meganet.admin_photo_upload_tokens()::text');
  perform pg_temp.check_that('an administrator lists the keys, without hash or key',
    v like '%Check Acme Surveys%' and v not like '%' || (acme ->> 'token') || '%'
      and v not like '%' || pg_temp.hash(acme ->> 'token') || '%', left(v, 120));
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
    'select meganet.admin_create_photo_upload_token(''Check Editor Mint'')::text');
  perform pg_temp.check_that('an editor may not mint a key', v like 'ERROR 42501', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'),
    'select meganet.admin_photo_upload_tokens()::text');
  perform pg_temp.check_that('anonymous may not list the keys', v like 'ERROR 42501', v);
  perform pg_temp.check_that('two live keys may not share a label',
    pg_temp.state_of('select pg_temp.mint(''check acme surveys'')') = '23505');
  perform pg_temp.check_that('a daily allowance over 5000 is refused',
    pg_temp.state_of('select pg_temp.mint(''Check Huge'', 6000)') = '22023');

  -- Who may reach the Worker's functions
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
    format('select meganet.photo_upload_check(%L)::text', pg_temp.hash(acme ->> 'token')));
  perform pg_temp.check_that('even an administrator''s browser cannot check a key', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
    'select count(*)::text from meganet.photo_upload_receipt');
  perform pg_temp.check_that('no browser reads the receipts', v = 'ERROR 42501', v);
  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'),
    format('select meganet.photo_upload_check(%L) ->> ''label''', pg_temp.hash(acme ->> 'token')));
  perform pg_temp.check_that('the secret key checks a key by its hash', v = 'Check Acme Surveys', v);
  perform pg_temp.check_that('a wrong key is no key',
    meganet.photo_upload_check(pg_temp.hash('fnp_' || repeat('0', 64))) is null);

  -- Accepting
  r1 := pg_temp.offer(aid, 'one', '{"station_id":"_check_pu_a","caption":"gauge board"}');
  perform pg_temp.check_that('a new photo is accepted as receiving, fresh',
    r1 ->> 'state' = 'receiving' and (r1 ->> 'fresh')::boolean, r1::text);
  rx := pg_temp.offer(aid, 'one');
  perform pg_temp.check_that('the same photo again while it is received is busy',
    rx ->> 'refused' = 'busy', rx::text);
  perform pg_temp.check_that('stored moves it to waiting',
    meganet.photo_upload_stored((r1 ->> 'receipt')::uuid) ->> 'state' = 'waiting');
  r2 := pg_temp.offer(aid, 'one');
  perform pg_temp.check_that('the same photo again is the same receipt, not fresh',
    r2 ->> 'receipt' = r1 ->> 'receipt' and not (r2 ->> 'fresh')::boolean and r2 ->> 'state' = 'waiting', r2::text);
  r2 := pg_temp.offer(tid, 'one');
  perform pg_temp.check_that('another key sending the same bytes gets its own receipt',
    r2 ->> 'receipt' <> r1 ->> 'receipt', r2::text);

  perform pg_temp.check_that('a station that does not exist is refused before storing',
    pg_temp.state_of(format('select pg_temp.offer(%s, ''bad1'', ''{"station_id":"_nope"}'')', aid)) = '22023');
  perform pg_temp.check_that('half a position is refused',
    pg_temp.state_of(format('select pg_temp.offer(%s, ''bad2'', ''{"lat":-27}'')', aid)) = '22023');
  perform pg_temp.check_that('a time with no zone is refused',
    pg_temp.state_of(format('select pg_temp.offer(%s, ''bad3'', ''{"taken_at":"2026-11-27T10:00:00"}'')', aid)) = '22023');
  perform pg_temp.check_that('a hint not on the list is refused',
    pg_temp.state_of(format('select pg_temp.offer(%s, ''bad4'', ''{"uploaded_by":"me"}'')', aid)) = '22023');
  perform pg_temp.check_that('a time with its zone is accepted',
    pg_temp.offer(aid, 'good5', '{"taken_at":"2026-11-27T10:00:00+10:00","lat":-31.5,"lon":161.0}') ->> 'state' = 'receiving');
  perform pg_temp.check_that('abandon takes a receiving receipt away',
    meganet.photo_upload_abandon((pg_temp.offer(aid, 'cut') ->> 'receipt')::uuid)
    and pg_temp.offer(aid, 'cut') ->> 'fresh' = 'true');

  -- The daily allowance: tiny has 2, and has used one ('one').
  perform pg_temp.check_that('the allowance admits up to its number',
    pg_temp.offer(tid, 'two') ->> 'state' = 'receiving');
  rx := pg_temp.offer(tid, 'three');
  perform pg_temp.check_that('and refuses the one after', rx ->> 'refused' = 'day_limit', rx::text);
  perform pg_temp.check_that('but a repeat of one it has is still its receipt',
    pg_temp.offer(tid, 'two') ->> 'refused' = 'busy');

  -- Already in Flood-Net by another way in
  perform pg_catalog.set_config('request.jwt.claims', (select claims from _who where k = 'editor'), true);
  photo := (meganet.add_field_photo(jsonb_build_object(
    'storage_path', 'photo/' || gen_random_uuid() || '.jpg', 'content_type', 'image/jpeg',
    'byte_size', 1000, 'sha256', pg_temp.sha('elsewhere'), 'title', 'x.jpg', 'station_id', '_check_pu_a')) ->> 'id')::uuid;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  rx := pg_temp.offer(aid, 'elsewhere');
  perform pg_temp.check_that('a photo already in Flood-Net is a settled duplicate, nothing to store',
    rx ->> 'state' = 'duplicate' and rx ->> 'photo_id' = photo::text and not (rx ->> 'fresh')::boolean
      and rx ->> 'station_id' = '_check_pu_a', rx::text);

  -- Status: only for the key that has it
  perform pg_temp.check_that('a key reads its own receipt',
    meganet.photo_upload_status(aid, (r1 ->> 'receipt')::uuid) ->> 'state' = 'waiting');
  perform pg_temp.check_that('another key reads nothing',
    meganet.photo_upload_status(tid, (r1 ->> 'receipt')::uuid) is null);

  -- The sync's side
  v := (select string_agg(x ->> 'label', ',') from jsonb_array_elements(meganet.photo_upload_waiting(50)) x
         where x ->> 'receipt' = r1 ->> 'receipt');
  perform pg_temp.check_that('waiting lists the stored photo with its key''s label', v = 'Check Acme Surveys', coalesce(v, '<none>'));
  perform pg_temp.check_that('waiting carries the hints',
    (select x -> 'hints' ->> 'caption' from jsonb_array_elements(meganet.photo_upload_waiting(50)) x
      where x ->> 'receipt' = r1 ->> 'receipt') = 'gauge board');
  perform pg_temp.check_that('a failure leaves it waiting',
    meganet.photo_upload_settle((r1 ->> 'receipt')::uuid, '{"outcome":"failed","reason":"network"}') ->> 'state' = 'waiting');
  perform pg_temp.check_that('settling imported says imported',
    meganet.photo_upload_settle((r1 ->> 'receipt')::uuid,
      jsonb_build_object('outcome', 'imported', 'photo_id', photo, 'station_id', '_check_pu_a')) ->> 'state' = 'imported');
  perform pg_temp.check_that('and records the photo and the station',
    (select photo_id = photo and station_id = '_check_pu_a' and settled_at is not null
           from meganet.photo_upload_receipt where id = (r1 ->> 'receipt')::uuid));
  perform pg_temp.check_that('a settled receipt does not settle again',
    meganet.photo_upload_settle((r1 ->> 'receipt')::uuid, '{"outcome":"refused"}') ->> 'state' = 'imported');
  rx := pg_temp.offer(aid, 'flaky');
  perform meganet.photo_upload_stored((rx ->> 'receipt')::uuid);
  for i in 1..4 loop
    perform meganet.photo_upload_settle((rx ->> 'receipt')::uuid, '{"outcome":"failed","reason":"timeout"}');
  end loop;
  perform pg_temp.check_that('the fifth failure refuses it',
    meganet.photo_upload_settle((rx ->> 'receipt')::uuid, '{"outcome":"failed","reason":"timeout"}') ->> 'state' = 'refused');
  perform pg_temp.check_that('saying it was tried five times',
    (select reason like 'tried five times%' from meganet.photo_upload_receipt where id = (rx ->> 'receipt')::uuid));
  perform pg_temp.check_that('an outcome that is not one is refused',
    pg_temp.state_of(format('select meganet.photo_upload_settle(%L, ''{"outcome":"lost"}'')', r1 ->> 'receipt')) = '22023');

  -- Revoking and the vocabularies
  perform pg_catalog.set_config('request.jwt.claims', (select claims from _who where k = 'admin'), true);
  perform meganet.admin_revoke_photo_upload_token(aid);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  perform pg_temp.check_that('a revoked key checks as no key',
    meganet.photo_upload_check(pg_temp.hash(acme ->> 'token')) is null);
  perform pg_temp.check_that('and accepts nothing more',
    pg_temp.offer(aid, 'after') ->> 'refused' = 'key');
  perform pg_temp.check_that('the api origin and the sender placement exist',
    exists (select 1 from meganet.field_photo_origin where key = 'api')
    and exists (select 1 from meganet.field_photo_placement where key = 'sender'));
  perform pg_temp.check_that('a photo may be timed by its sender',
    pg_temp.state_of('update meganet.field_photo set taken_source = ''sender'' where false') = 'ok'
    and exists (select 1 from pg_catalog.pg_constraint where conname = 'field_photo_taken_source'
                 and pg_catalog.pg_get_constraintdef(oid) like '%sender%'));
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

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
