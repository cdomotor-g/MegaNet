-- check_reading_signal.sql — Prove 0050, a reading's frequency and signal,
-- against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_reading_signal.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the token and the readings included — so it is safe against
-- the live database. Run it as a role meganet.is_editor() says yes to (a
-- direct connection), as check_ingest.sql is.
--
-- Addresses 64501–64520: inside the ALERT range, clear of check_ingest.sql's
-- 64001–64200 and check_receptions.sql's 643xx, and far from the network.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.sqlstate_of(p_sql text)
returns text language plpgsql as $$ begin execute p_sql; return 'none'; exception when others then return sqlstate; end; $$;
create or replace function pg_temp.ts(p_ago interval)
returns text language sql stable as $$ select to_char(date_trunc('second', now()) - p_ago, 'YYYY-MM-DD"T"HH24:MI:SSOF'); $$;

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 50',
    (select value::integer >= 50 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('reading has freq_mhz numeric and three real signal columns',
    (select count(*) = 4 from information_schema.columns
      where table_schema = 'meganet' and table_name = 'reading'
        and ((column_name = 'freq_mhz' and data_type = 'numeric')
          or (column_name in ('rssi_dbm', 'level_dbfs', 'snr_db') and data_type = 'real'))
        and is_nullable = 'YES' and column_default is null));

  perform pg_temp.check_that('anon reads them, as it reads the rest of a reading',
    has_column_privilege('anon', 'meganet.reading', 'freq_mhz', 'select')
      and has_column_privilege('anon', 'meganet.reading', 'rssi_dbm', 'select')
      and has_column_privilege('anon', 'meganet.reading', 'level_dbfs', 'select')
      and has_column_privilege('anon', 'meganet.reading', 'snr_db', 'select'));

  perform pg_temp.check_that('anon still cannot write readings, or run ingest() or the new helper',
    not has_table_privilege('anon', 'meganet.reading', 'insert')
      and not has_function_privilege('anon', 'meganet.ingest(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.as_num_within(jsonb, numeric, numeric)', 'execute'));

  perform pg_temp.check_that('as_num_within: a number, a numeric string, else null — never an error',
    meganet.as_num_within('151.525', 0.001, 100000) = 151.525
      and meganet.as_num_within('" -87.5 "', -200, 50) = -87.5
      and meganet.as_num_within('151500000', 0.001, 100000) is null
      and meganet.as_num_within('"loud"', -200, 50) is null
      and meganet.as_num_within('"NaN"', -200, 50) is null
      and meganet.as_num_within('true', -200, 50) is null
      and meganet.as_num_within('{"v":1}', -200, 50) is null
      and meganet.as_num_within('null', -200, 50) is null
      and meganet.as_num_within(null, -200, 50) is null
      and meganet.as_num_within('"1e999999"', -200, 50) is null
      and meganet.as_num_within('1e999', -200, 50) is null);
end
$$;

-- ── 2. Through ingest(): stored, defaulted, and never a reason to refuse ────

do $$
declare
  a jsonb;
  r record;
begin
  a := meganet.ingest(format($j${"source":"serial","protocol":"alert","path":"serial-monitor/_check-sdr1","freq_mhz":151.5,"readings":[
        {"alert_id":64501,"reading_ts":"%1$s","value_raw":10,"level_dbfs":-57.638,"snr_db":11.04},
        {"alert_id":64502,"reading_ts":"%1$s","value_raw":20,"freq_mhz":152.4,"rssi_dbm":-91,"snr_db":"14.5"},
        {"alert_id":64503,"reading_ts":"%1$s","value_raw":30},
        {"alert_id":64504,"reading_ts":"%1$s","value_raw":40,"freq_mhz":151525000,"rssi_dbm":300,"level_dbfs":"loud","snr_db":true},
        {"alert_id":64505,"reading_ts":"%1$s","value_raw":50,"freq_mhz":-1,"rssi_dbm":"NaN","level_dbfs":1e-50,"snr_db":{"v":9}},
        {"alert_id":64506,"reading_ts":"%1$s","value_raw":60,"freq_mhz":"151.5250000004"}]}$j$,
        pg_temp.ts('10 minutes'))::jsonb);

  perform pg_temp.check_that('every reading is stored, whatever its signal said',
    (a ->> 'accepted') = '6' and jsonb_array_length(a -> 'rejected') = 0, a::text);

  select * into r from meganet.reading where alert_id = 64501;
  perform pg_temp.check_that('an SDR reading keeps its level and SNR, and the envelope''s frequency',
    r.freq_mhz = 151.5 and r.level_dbfs = -57.64::real and r.snr_db = 11.04::real and r.rssi_dbm is null,
    format('freq %s level %s snr %s rssi %s', r.freq_mhz, r.level_dbfs, r.snr_db, r.rssi_dbm));

  select * into r from meganet.reading where alert_id = 64502;
  perform pg_temp.check_that('a row''s own frequency wins over the envelope''s; a numeric string is a number',
    r.freq_mhz = 152.4 and r.rssi_dbm = -91 and r.snr_db = 14.5::real and r.level_dbfs is null,
    format('freq %s rssi %s snr %s', r.freq_mhz, r.rssi_dbm, r.snr_db));

  select * into r from meganet.reading where alert_id = 64503;
  perform pg_temp.check_that('a reading that says nothing about its signal stores none',
    r.rssi_dbm is null and r.level_dbfs is null and r.snr_db is null and r.freq_mhz = 151.5);

  select * into r from meganet.reading where alert_id = 64504;
  perform pg_temp.check_that('a frequency in Hz, an RSSI of +300 and words are nulls, not a refusal',
    r.freq_mhz = 151.5 and r.rssi_dbm is null and r.level_dbfs is null and r.snr_db is null,
    format('freq %s rssi %s level %s snr %s', r.freq_mhz, r.rssi_dbm, r.level_dbfs, r.snr_db));

  select * into r from meganet.reading where alert_id = 64505;
  perform pg_temp.check_that('a negative frequency, NaN and an object are nulls; 1e-50 is 0, not an underflow',
    r.freq_mhz = 151.5 and r.rssi_dbm is null and r.level_dbfs = 0 and r.snr_db is null,
    format('freq %s rssi %s level %s snr %s', r.freq_mhz, r.rssi_dbm, r.level_dbfs, r.snr_db));

  perform pg_temp.check_that('the frequency is kept to the hertz',
    (select freq_mhz = 151.525 and scale(freq_mhz) <= 6 from meganet.reading where alert_id = 64506));
end
$$;

-- ── 3. A duplicate keeps the first copy's frequency and signal ───────────────

do $$
declare
  a jsonb;
  r record;
begin
  a := meganet.ingest(format($j${"source":"serial","protocol":"alert","path":"serial-monitor/_check-sdr1-152.400","readings":[
        {"alert_id":64501,"reading_ts":"%1$s","value_raw":10,"freq_mhz":152.4,"level_dbfs":-31,"snr_db":30}]}$j$,
        pg_temp.ts('10 minutes'))::jsonb);
  select * into r from meganet.reading where alert_id = 64501;
  perform pg_temp.check_that('a second copy is counted and its path kept, its signal not',
    (a ->> 'duplicates') = '1' and r.dup_count = 1
      and r.dup_paths = array['serial-monitor/_check-sdr1-152.400']
      and r.path = 'serial-monitor/_check-sdr1'
      and r.freq_mhz = 151.5 and r.level_dbfs = -57.64::real and r.snr_db = 11.04::real,
    format('%s | path %s dup %s freq %s level %s', a, r.path, r.dup_paths, r.freq_mhz, r.level_dbfs));
end
$$;

-- ── 4. The Raspberry Pi's route: ingest_http() with a token ──────────────────

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_signal pi') ->> 'token') as token;

do $$
declare
  a jsonb;
  r record;
begin
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', (select token from _tok)), true);
  a := meganet.ingest_http(format($j${"source":"serial","protocol":"alert","path":"serial-monitor/rpi-check-sdr1","readings":[
        {"alert_id":64510,"reading_ts":"%1$s","value_raw":141,"freq_mhz":151.525,"level_dbfs":-53.3,"snr_db":15.7},
        {"alert_id":64511,"reading_ts":"%1$s","value_raw":51,"freq_mhz":151.525,"rssi_dbm":-102.5}]}$j$,
        pg_temp.ts('5 minutes'))::jsonb);
  perform set_config('request.headers', '', true);
  perform pg_temp.check_that('a base station''s batch lands with its frequency and signal',
    (a ->> 'accepted') = '2'
      and (select freq_mhz = 151.525 and level_dbfs = -53.3::real and snr_db = 15.7::real
             from meganet.reading where alert_id = 64510)
      and (select rssi_dbm = -102.5::real from meganet.reading where alert_id = 64511),
    a::text);
  perform pg_temp.check_that('and it is still the token''s reading',
    (select bool_and(ingest_token_id = (select id from meganet.ingest_token where label = '_check_signal pi'))
       from meganet.reading where alert_id in (64510, 64511)));
end
$$;

-- ── 5. The table refuses what ingest() would never write ─────────────────────

do $$
begin
  perform pg_temp.check_that('a frequency, RSSI, level or SNR out of range is refused by the table itself',
    pg_temp.sqlstate_of(format($q$insert into meganet.reading (alert_id, reading_ts, value_raw, freq_mhz) values (64520, '%s', 1, 151500000)$q$, pg_temp.ts('1 minute'))) = '23514'
      and pg_temp.sqlstate_of(format($q$insert into meganet.reading (alert_id, reading_ts, value_raw, rssi_dbm) values (64520, '%s', 2, 300)$q$, pg_temp.ts('1 minute'))) = '23514'
      and pg_temp.sqlstate_of(format($q$insert into meganet.reading (alert_id, reading_ts, value_raw, level_dbfs) values (64520, '%s', 3, 'NaN')$q$, pg_temp.ts('1 minute'))) = '23514'
      and pg_temp.sqlstate_of(format($q$insert into meganet.reading (alert_id, reading_ts, value_raw, snr_db) values (64520, '%s', 4, -101)$q$, pg_temp.ts('1 minute'))) = '23514');
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
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
