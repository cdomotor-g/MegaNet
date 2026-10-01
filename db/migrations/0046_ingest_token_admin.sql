-- 0046_ingest_token_admin.sql — Ingest tokens from the Admin tab, not the SQL
-- editor.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0046_ingest_token_admin.sql
--
-- Why this file exists
-- ────────────────────
-- docs/ingest-http.md said token issuing could stay a database operation "until
-- it is actually needed". 0045 made it needed: every computer a Serial Monitor
-- receiver posts from is an ingest point and needs its own token, and asking
-- whoever sets one up to open the Supabase SQL editor is the step that stops
-- it happening. So three functions for the Admin tab, each refusing anybody
-- meganet.is_admin() says no to (meganet.admin_require(), 0043):
--
--   admin_ingest_tokens()                    every token: label, where it lives,
--                                            who made it, last used, revoked —
--                                            and the receivers behind it (0045).
--                                            Never the hash.
--   admin_create_ingest_token(label, host)   mints one through the existing
--                                            meganet.create_ingest_token(), so
--                                            the token format, the hashing and
--                                            created_by stay in one place. The
--                                            plaintext is returned once, as it
--                                            always was.
--   admin_revoke_ingest_token(id)            sets revoked_at — immediate, as it
--                                            always was. Never un-revokes: a
--                                            token that leaked stays dead, and a
--                                            replacement is a new token.
--
-- Nothing about who may *use* a token changes. meganet.ingest_token keeps RLS
-- on with no policy; these functions are the only new way to see it, and they
-- answer administrators only.

create or replace function meganet.admin_ingest_tokens()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id',              t.id,
             'label',           t.label,
             'host_station_id', t.host_station_id,
             'host_station',    s.name,
             'created_at',      t.created_at,
             'created_by',      t.created_by,
             'last_used_at',    t.last_used_at,
             'revoked_at',      t.revoked_at,
             'receivers',       coalesce((
               select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'point_id', p.point_id, 'name', p.name, 'receiver', p.receiver,
                        'location_source', p.location_source, 'location_approx', p.location_approx,
                        'last_seen_at', p.last_seen_at)
                      order by p.last_seen_at desc)
                 from meganet.ingest_point_latest p
                where p.ingest_token_id = t.id), '[]'::jsonb))
           order by t.revoked_at is not null, t.last_used_at desc nulls last, t.id desc)
      from meganet.ingest_token t
      left join meganet.station s on s.id = t.host_station_id
  ), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_ingest_tokens() is
  'Every ingest token, for the Admin tab (0046): label, host station, who made it, last used, revoked, and the receivers that have reported behind it (0045). Never the hash. Administrators only.';

create or replace function meganet.admin_create_ingest_token(p_label text, p_host_station_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_host  text := nullif(pg_catalog.btrim(coalesce(p_host_station_id, '')), '');
begin
  perform meganet.admin_require();
  if v_label = '' then
    raise exception 'a token needs a label — name the computer or base station it is for'
      using errcode = '22023';
  end if;
  if pg_catalog.length(v_label) > 120 then
    raise exception 'a label of at most 120 characters, please' using errcode = '22023';
  end if;
  if exists (select 1 from meganet.ingest_token t
              where pg_catalog.lower(t.label) = pg_catalog.lower(v_label) and t.revoked_at is null) then
    raise exception 'a live token is already called %, and two would be impossible to tell apart — choose another label, or revoke that one first', v_label
      using errcode = '23505';
  end if;
  if v_host is not null and not exists (select 1 from meganet.station s where s.id = v_host) then
    raise exception 'no station %', v_host using errcode = '22023';
  end if;
  return meganet.create_ingest_token(v_label, v_host);
end;
$$;

comment on function meganet.admin_create_ingest_token(text, text) is
  'Mint an ingest token from the Admin tab (0046), through meganet.create_ingest_token(): the plaintext is returned once and only its hash is kept. A label must be unique among live tokens. Administrators only.';

create or replace function meganet.admin_revoke_ingest_token(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.ingest_token;
begin
  perform meganet.admin_require();
  update meganet.ingest_token set revoked_at = pg_catalog.now()
   where id = p_id and revoked_at is null
  returning * into v_row;
  if v_row.id is null then
    if not exists (select 1 from meganet.ingest_token where id = p_id) then
      raise exception 'no ingest token %', p_id using errcode = '22023';
    end if;
    select * into v_row from meganet.ingest_token where id = p_id;
  end if;
  return pg_catalog.jsonb_build_object('id', v_row.id, 'label', v_row.label, 'revoked_at', v_row.revoked_at);
end;
$$;

comment on function meganet.admin_revoke_ingest_token(bigint) is
  'Revoke an ingest token from the Admin tab (0046): revoked_at set, effective on the token''s next request. Revoking a revoked token is a no-op; nothing un-revokes. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.admin_ingest_tokens()                    from public;
revoke all on function meganet.admin_create_ingest_token(text, text)    from public;
revoke all on function meganet.admin_revoke_ingest_token(bigint)        from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- authenticated, not anon: each one asks admin_require() as well, but an
  -- anonymous caller has no business reaching the question.
  grant execute on function meganet.admin_ingest_tokens()                 to authenticated, service_role;
  grant execute on function meganet.admin_create_ingest_token(text, text) to authenticated, service_role;
  grant execute on function meganet.admin_revoke_ingest_token(bigint)     to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('meganet.admin_create_ingest_token(text, text)') is null
     or to_regprocedure('meganet.admin_revoke_ingest_token(bigint)') is null
     or to_regprocedure('meganet.admin_ingest_tokens()') is null then
    raise exception '0046 did not take: the Admin tab''s token functions are missing';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 45 → 46 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '46')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
