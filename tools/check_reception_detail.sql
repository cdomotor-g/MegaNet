-- check_reception_detail.sql — Prove 0072, a reception's detail kept as typed
-- columns (#242), against a real database: nothing posted is lost or changed.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_reception_detail.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the token, the people and the receptions included — so it is
-- safe against the live database. The backfill check needs a superuser (to
-- store a row the old way, with the trigger off for this session only); where
-- there is none, as on Supabase, it says so and passes.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare v text;
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

insert into meganet.editor_allow (entry, note) values ('rd-editor@example.test', 'check_reception_detail — rolled back') on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000ee701', 'rd-editor@example.test', now()) on conflict (id) do nothing;

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_rd pi') ->> 'token') as token;

-- What the receivers post, as they post it. Heard 40 days ago, an hour the
-- live table has nothing in.
create temporary table _posted (k text primary key, detail jsonb) on commit drop;
insert into _posted values
  -- An RPi ALERT ALERT2 copy, every key the agent sends.
  ('a2',      '{"app":"RPi ALERT","fmt":"ALERT2","baud":4800,"late":false,"path":[11056,10019],"sync":0.96,"clock":"utc","fixed":0,"stamp":15621,"cfo_hz":262,"snr_db":21.6,"source":33300,"nf_dbfs":-61.5,"before_s":20,"freq_mhz":151.5375,"duplicate":true,"hop_limit":3}'),
  -- A legacy ALERT copy: other keys, a null among them.
  ('abf',     '{"app":"RPi ALERT","crc":null,"fmt":"ABF","snr_db":13.4,"nf_dbfs":-69.4,"freq_mhz":152.25,"polarity":"STD","carrier_hz":2838}'),
  -- Values a column cannot take exactly, or of the wrong type: all stay put.
  ('odd',     '{"snr_db":1.2345678901,"nf_dbfs":"quiet","source":"33300","path":[1,"x"],"hop_limit":99999,"duplicate":"yes","fmt":7,"freq_mhz":151.53750000000001,"sync":1e40}'),
  -- Browser keys (serial-ert.js, serial-radio.js), none of them moved but source.
  ('browser', '{"source":4321,"port":0,"hop_limit":2,"self_report":true,"uptime_ms":123456,"fade":3}'),
  -- A drive's: survey stays in detail (its index is on it).
  ('survey',  '{"survey":"rd-survey-1","survey_name":"Check drive","snr_db":9.5,"freq_mhz":151.5375,"app":"RPi ALERT"}'),
  ('empty',   '{}'),
  ('emptypath', '{"path":[],"source":10019}');

do $$
declare
  v_tok text := (select token from _tok);
  b     jsonb;
  r     jsonb;
begin
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', v_tok), true);
  b := jsonb_build_object('point_id', 'rd-sdr1', 'receiver', 'rtl-sdr', 'receptions',
         (select jsonb_agg(jsonb_build_object(
                   'heard_at', to_char(now() - interval '40 days' + q.i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
                   'protocol', case when q.k = 'abf' then 'alert' else 'alert2' end,
                   'alert_id', 600 + q.i,
                   'value_raw', 1, 'ok', true, 'level_dbfs', -30,
                   'payload_hex', upper(encode(convert_to(q.k, 'UTF8'), 'hex')), 'detail', q.detail))
            from (select k, detail, row_number() over (order by k) as i from _posted) q));
  r := meganet.report_receptions(b);
  perform pg_temp.check_that('every posted reception is stored', (r ->> 'accepted')::int = 7, r::text);
end
$$;

create temporary table _stored on commit drop as
  select p.k, p.detail as posted, x.id
    from _posted p
    join meganet.reception x on x.point_id = 'rd-sdr1' and x.payload_hex = upper(encode(convert_to(p.k, 'UTF8'), 'hex'));
create or replace function pg_temp.rx(p_k text) returns meganet.reception language sql as
  $$ select x.* from meganet.reception x join _stored s on s.id = x.id where s.k = p_k $$;
create or replace function pg_temp.posted(p_k text) returns jsonb language sql as
  $$ select detail from _posted where k = p_k $$;

do $$
declare
  c meganet.reception;
  v_bad text;
begin
  select string_agg(s.k, ', ') into v_bad from _stored s
   where meganet.reception_detail(pg_temp.rx(s.k)) is distinct from s.posted;
  perform pg_temp.check_that('all seven posted receptions are here', (select count(*) from _stored) = 7);
  perform pg_temp.check_that('reception_detail() gives back every posted detail exactly', v_bad is null, coalesce(v_bad, ''));

  c := pg_temp.rx('a2');
  perform pg_temp.check_that('an ALERT2 copy''s keys are in their columns',
    c.snr_db = 21.6::real and c.nf_dbfs = -61.5::real and c.freq_mhz = 151.5375 and c.cfo_hz = 262 and c.sync = 0.96::real
      and c.baud = 4800 and c.before_s = 20 and c.a2_source = 33300 and c.a2_path = array[11056, 10019]
      and c.hop_limit = 3 and c.a2_stamp = 15621 and c.a2_fixed = 0 and c.a2_duplicate and not c.a2_late
      and c.fmt = 'ALERT2' and c.app = 'RPi ALERT' and c.clock = 'utc', pg_catalog.row_to_json(c)::text);
  perform pg_temp.check_that('… and its detail is empty', c.detail = '{}'::jsonb, c.detail::text);

  c := pg_temp.rx('abf');
  perform pg_temp.check_that('a legacy copy keeps its own keys, the null among them, in detail',
    c.detail = '{"crc":null,"polarity":"STD","carrier_hz":2838}'::jsonb and c.snr_db = 13.4::real and c.fmt = 'ABF', c.detail::text);

  c := pg_temp.rx('odd');
  perform pg_temp.check_that('what a column cannot take exactly stays in detail, untouched',
    c.detail = pg_temp.posted('odd') and c.snr_db is null and c.a2_source is null and c.a2_path is null and c.hop_limit is null
      and c.a2_duplicate is null and c.fmt is null and c.sync is null, c.detail::text);

  c := pg_temp.rx('browser');
  perform pg_temp.check_that('a browser copy: source and hop limit moved, the rest kept',
    c.a2_source = 4321 and c.hop_limit = 2 and c.detail = '{"port":0,"self_report":true,"uptime_ms":123456,"fade":3}'::jsonb, c.detail::text);

  c := pg_temp.rx('survey');
  perform pg_temp.check_that('a drive''s survey and name stay in detail, where its index is',
    c.detail = '{"survey":"rd-survey-1","survey_name":"Check drive"}'::jsonb and c.freq_mhz = 151.5375, c.detail::text);

  c := pg_temp.rx('emptypath');
  perform pg_temp.check_that('an empty path is an empty array, and comes back as one',
    c.a2_path = '{}'::integer[] and meganet.reception_detail(c) -> 'path' = '[]'::jsonb, pg_catalog.row_to_json(c)::text);

  perform pg_temp.check_that('a split row is smaller than the same row unsplit',
    pg_column_size(pg_temp.rx('a2')) + 100 < pg_column_size(pg_temp.rx('a2')) - pg_column_size((pg_temp.rx('a2')).detail) + pg_column_size(pg_temp.posted('a2')),
    pg_column_size(pg_temp.rx('a2'))::text || ' bytes split, against '
      || (pg_column_size(pg_temp.rx('a2')) - pg_column_size((pg_temp.rx('a2')).detail) + pg_column_size(pg_temp.posted('a2')))::text || ' with the posted detail in it');
end
$$;

-- An update of detail is split too: a key put back is moved again.
update meganet.reception set detail = detail || '{"snr_db":30.5,"kind":"other"}'::jsonb
 where point_id = 'rd-sdr1' and payload_hex = upper(encode(convert_to('a2', 'UTF8'), 'hex'));

do $$
declare c meganet.reception;
begin
  select * into c from meganet.reception where point_id = 'rd-sdr1' and payload_hex = upper(encode(convert_to('a2', 'UTF8'), 'hex'));
  perform pg_temp.check_that('an update of detail is split as an insert is',
    c.snr_db = 30.5::real and c.detail = '{"kind":"other"}'::jsonb
      and meganet.reception_detail(c) ->> 'source' = '33300', c.detail::text);
end
$$;

-- The readers hand the app the whole detail.
do $$
declare
  c_editor text := '{"role":"authenticated","email":"rd-editor@example.test","sub":"00000000-0000-4000-8000-0000000ee701"}';
  v text;
  w jsonb;
begin
  v := pg_temp.as_role('authenticated', c_editor,
    $q$select meganet.reception_window(now() - interval '40 days' - interval '1 minute', now() - interval '40 days' + interval '1 minute', 1000)::text$q$);
  perform pg_temp.check_that('the Reception Map''s window still answers', v not like 'ERROR %', left(v, 200));
  if v not like 'ERROR %' then
    w := (select x from jsonb_array_elements(v::jsonb) x where x ->> 'point_id' = 'rd-sdr1' and x ->> 'payload_hex' = upper(encode(convert_to('abf', 'UTF8'), 'hex')));
    perform pg_temp.check_that('… with a copy''s detail whole, as posted',
      w -> 'detail' = (select detail from _posted where k = 'abf'), coalesce(w::text, '<none>'));
  end if;

  v := pg_temp.as_role('authenticated', c_editor, $q$select meganet.survey_receptions('rd-survey-1')::text$q$);
  perform pg_temp.check_that('a survey''s receptions still carry their whole detail',
    case when v like 'ERROR %' then false
         else (v::jsonb -> 0 -> 'detail') = (select detail from _posted where k = 'survey') end, left(v, 300));

  v := pg_temp.as_role('authenticated', c_editor, $q$select meganet.survey_summary('rd-survey-1')::text$q$);
  perform pg_temp.check_that('a survey''s summary still reads the frequency and the SNR',
    case when v like 'ERROR %' then false
         else (v::jsonb -> 'points' -> 0 ->> 'freq_mhz')::numeric = 151.5375
              and (v::jsonb -> 'stations' -> 0 ->> 'snr_db')::numeric = 9.5 end, left(v, 300));
end
$$;

-- The indexes.
do $$
begin
  perform pg_temp.check_that('reception_alert_idx is gone, and its survey-only successor is in its place',
    to_regclass('meganet.reception_alert_idx') is null
      and (select indexdef from pg_indexes where schemaname = 'meganet' and indexname = 'reception_survey_alert_idx')
          like '%(alert_id, heard_at) WHERE (detail ? ''survey''::text)');
  perform pg_temp.check_that('reading_ingest_token_idx stays (what did this token write)',
    to_regclass('meganet.reading_ingest_token_idx') is not null);
end
$$;

-- The backfill: a row stored the old way (the trigger off for this session
-- only, which needs a superuser) is split by it, and comes back the same.
do $$
declare
  v_id bigint;
  v_r  jsonb;
  c    meganet.reception;
  v_d  jsonb := (select detail from _posted where k = 'a2');
begin
  begin
    set local session_replication_role = replica;
  exception when insufficient_privilege then
    perform pg_temp.check_that('the backfill splits an old row (skipped: needs a superuser)', true, 'skipped');
    return;
  end;
  insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, ok, detail)
  select id, 'rd-sdr1', 'rtl-sdr', now() - interval '40 days' + interval '1 hour', 'alert2', true, v_d
    from meganet.ingest_token where label = '_check_rd pi'
  returning id into v_id;
  set local session_replication_role = origin;

  select * into c from meganet.reception where id = v_id;
  perform pg_temp.check_that('a row stored the old way has its keys in detail', c.detail = v_d and c.snr_db is null);

  insert into meganet.app_meta (key, value) values ('reception_split_backfill_from', (v_id - 1)::text)
  on conflict (key) do update set value = excluded.value;
  v_r := meganet.reception_split_backfill(10);
  select * into c from meganet.reception where id = v_id;
  perform pg_temp.check_that('the backfill splits it, and it comes back the same',
    (v_r ->> 'updated')::int >= 1 and c.detail = '{}'::jsonb and c.a2_source = 33300
      and meganet.reception_detail(c) = v_d, v_r::text);
end
$$;

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 200) end as detail
  from _check order by ord;

do $$
declare n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then raise exception '% of % checks failed', n, (select count(*) from _check); end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
