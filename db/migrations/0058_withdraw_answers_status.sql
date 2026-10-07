-- 0058_withdraw_answers_status.sql — Withdrawing a token request answers how
-- it stands again, as 0048 promised, while still deleting a waiting one.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0058_withdraw_answers_status.sql
--
-- Why this file exists
-- ────────────────────
-- 0053 (appraisal H-3) made withdraw_ingest_token_request() delete a pending
-- request instead of marking it 'withdrawn', so request-then-withdraw in a loop
-- leaves nothing behind. That part is right, and stays. But it also made the
-- function answer {"status":"withdrawn"} every time, whatever there was to
-- withdraw. 0048's contract — and docs/ingest-http.md — is that it answers the
-- request's status, and a decided request is left alone. So a device that
-- stops waiting a moment after an administrator approved it was told
-- "withdrawn" and would throw away a token that works; one that was denied was
-- told the same. tools/check_ingest_token_requests.sql ("withdrawing an approved
-- request leaves it approved") has failed since 0053 for exactly this.
--
-- Now: a pending request is deleted and the answer is "withdrawn"; anything
-- else is untouched and the answer is its status, as 0048 had it.

create or replace function meganet.withdraw_ingest_token_request(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := meganet.ingest_token_request_hash();
begin
  if v_hash is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'send the token the request was made with';
  end if;
  -- Delete, don't mark (0053, appraisal H-3): scoped to the caller's own
  -- token hash, and only while still pending.
  delete from meganet.ingest_token_request
   where token_hash = v_hash and status = 'pending';
  if found then
    -- The request is gone, so its status would read 'unknown'; say what happened.
    return pg_catalog.jsonb_build_object('status', 'withdrawn');
  end if;
  -- Nothing was waiting: a decided request is left alone, and the device is
  -- told how it stands — approved, denied, revoked or unknown.
  return meganet.ingest_token_request_state(v_hash);
end;
$$;

comment on function meganet.withdraw_ingest_token_request(jsonb) is
  'The device that made this X-Ingest-Token''s request stops waiting (0048, 0053, 0058): a pending request is deleted and the answer is withdrawn; a decided one is left alone and the answer is its status. Granted to anon.';

-- 0048's grants stand: create or replace keeps them.

-- ── Schema version ────────────────────────────────────────────────────────────
-- Apply after 0057. core.js DB_SCHEMA_VERSION follows once it is live.
insert into meganet.app_meta (key, value)
values ('schema_version', '58')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
