-- 0001_init.sql — the MegaNet datastore, from nothing.
--
-- Creates the `meganet` schema, the one shared updated_at trigger function every
-- later table inherits, and `meganet.app_meta`, whose schema_version row lets the
-- app tell an old database from a new one and say so rather than failing oddly
-- against a shape it does not understand.
--
-- Forward-only: once a migration has been applied anywhere it is never edited,
-- only followed by the next number. Every statement here is idempotent, so
-- re-running the file against a database that already has it is a no-op.
--
-- There is deliberately no `begin;`/`commit;` in this file — wrap it at the call
-- site instead, so it also works under tooling that has already opened a
-- transaction of its own:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0001_init.sql
--
-- See db/README.md.

-- ── Schema ───────────────────────────────────────────────────────────────────
-- MegaNet's tables live in their own schema rather than in `public`. `public` is
-- where Supabase's own machinery and every copy-pasted SQL snippet lands by
-- default; keeping our tables out of it means "what belongs to MegaNet" is
-- answerable by listing one schema, and nothing arrives there by accident.
create schema if not exists meganet;

comment on schema meganet is
  'MegaNet application data. Managed by db/migrations/ in the MegaNet repo.';

-- ── Shared conventions ───────────────────────────────────────────────────────
-- One place for "when was this row last touched". Every table below that carries
-- an updated_at column hangs this trigger off it, so the answer is the
-- database's and not a matter of each writer remembering to set it.
--
-- search_path is pinned empty and the built-in is schema-qualified on purpose: a
-- function with a mutable search_path can be steered into calling somebody
-- else's now() by whoever invokes it.
create or replace function meganet.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function meganet.touch_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with now(). Used by every table with that column.';

-- ── app_meta ─────────────────────────────────────────────────────────────────
-- Facts about the database itself, not about the radio network. Key/value rather
-- than a column per fact, because the alternative is a migration every time
-- there is one more thing worth recording.
--
-- The row that matters today is schema_version: the number of the highest
-- migration applied. The app reads it on load, compares it against the version
-- it was built for, and can then say "this database is older than this app"
-- instead of half-working against a shape it does not understand.
create table if not exists meganet.app_meta (
  key         text        primary key,
  value       text        not null,
  updated_at  timestamptz not null default now()
);

comment on table meganet.app_meta is
  'Facts about the database itself. schema_version = number of the highest migration applied.';

drop trigger if exists app_meta_touch_updated_at on meganet.app_meta;
create trigger app_meta_touch_updated_at
  before update on meganet.app_meta
  for each row execute function meganet.touch_updated_at();

-- The version this file leaves behind. Every later migration ends with the same
-- two lines carrying its own number, so schema_version and the highest applied
-- file cannot drift apart.
insert into meganet.app_meta (key, value)
values ('schema_version', '1')
on conflict (key) do update set value = excluded.value;

-- ── Row level security ───────────────────────────────────────────────────────
-- The anon key is committed to a public repo and that is fine — but only because
-- RLS is the thing actually protecting the data. A table with RLS off and that
-- key in the open is the whole database on the open internet.
--
-- So: every table gets `enable row level security` and an explicit policy in the
-- same migration that creates it. No exceptions, no follow-up ticket. See
-- db/README.md.
--
-- app_meta is world-readable by design — the app reads schema_version before it
-- has any credentials, and a version number is not a secret. The policy covers
-- select only; there is no policy for insert/update/delete, and no role is
-- granted them below, so a caller holding the anon key cannot write.
alter table meganet.app_meta enable row level security;

drop policy if exists app_meta_read_all on meganet.app_meta;
create policy app_meta_read_all on meganet.app_meta
  for select
  using (true);

-- ── Supabase Data API (PostgREST) ────────────────────────────────────────────
-- Everything below is Supabase-specific, and is skipped when the roles it needs
-- do not exist, so this file still runs against a plain Postgres.
--
-- Two separate things have to be true before a browser holding only the anon key
-- can read a table:
--
--   1. the role has been granted privileges on it. RLS decides which *rows* a
--      role sees; grants decide whether it can see the table at all.
--   2. the schema is in PostgREST's exposed list. `public` and `graphql_public`
--      are exposed by default; `meganet` is not, and a request for a table in an
--      unexposed schema fails as though the table did not exist.
do $$
declare
  exposed text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Granted read-only, and named table by table. There is deliberately no
  -- `alter default privileges` here: a blanket default would hand anon the
  -- *next* table the moment it is created, which is precisely the accident that
  -- enabling RLS in the same migration exists to prevent.
  grant usage  on schema meganet   to anon, authenticated, service_role;
  grant select on meganet.app_meta to anon, authenticated;
  grant select, insert, update, delete on meganet.app_meta to service_role;

  -- Add meganet to the exposed list without dropping whatever is already in it.
  -- Setting this by hand takes the list out of the dashboard's hands — Settings
  -- → Data API stops managing it — which is the trade we want: the exposed
  -- schemas become one more thing that lives in a migration rather than in a
  -- text box somebody has to remember to edit.
  select substr(cfg, length('pgrst.db_schemas=') + 1)
    into exposed
    from pg_catalog.pg_roles r,
         lateral unnest(coalesce(r.rolconfig, '{}'::text[])) as cfg
   where r.rolname = 'authenticator'
     and cfg like 'pgrst.db_schemas=%';

  exposed := coalesce(exposed, 'public, graphql_public');

  if exposed ~ '(^|,)\s*meganet\s*(,|$)' then
    raise notice 'meganet is already exposed to the Data API.';
  else
    execute format('alter role authenticator set pgrst.db_schemas = %L',
                   exposed || ', meganet');
  end if;

  -- Config for the schema list, schema for the new table. Both are delivered on
  -- commit, so a rolled-back migration never reconfigures a live API.
  notify pgrst, 'reload config';
  notify pgrst, 'reload schema';
end
$$;
