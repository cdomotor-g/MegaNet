-- pg_scaffold.sql — The Supabase-shaped surface a plain Postgres needs before
-- MegaNet's migrations will apply (#102's CI job; the shape #149 and #159
-- stood up by hand and proved the migrations against).
--
-- Everything here is the *environment* Supabase provides and the migrations
-- assume: the four API roles, an `auth` schema with the three claim readers,
-- and a minimal `storage` schema. The `authenticator` role matters most — the
-- migrations gate every Data API grant block on its existence, so a cluster
-- without it silently skips all grants and three permission checks fail in a
-- way that looks like a schema bug and is not (the #159 rehearsal's finding).
--
--   psql -v ON_ERROR_STOP=1 -f tools/ci/pg_scaffold.sql

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- The three claim readers, in their modern claims-JSON form — the form the
-- checks' synthetic sessions set (`request.jwt.claims`), not the per-claim
-- GUCs of older PostgREST.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''), 'anon')
$$;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '')
$$;

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table storage.objects enable row level security;
