-- =============================================================================
-- LOCAL TEST SHIM — NOT A MIGRATION. Never apply this to a Supabase project.
--
-- Recreates the small part of Supabase that the migrations depend on, so the
-- migrations and RLS verification can run in PGlite (PostgreSQL in WASM):
--   * API roles anon / authenticated / service_role (BYPASSRLS)
--   * Supabase's default privileges (ALL on public tables/functions to the API
--     roles) — reproduced so the tests prove our explicit REVOKEs matter
--   * auth.users (minimal columns) and auth.uid() with Supabase's definition
-- =============================================================================

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  last_sign_in_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Same definition Supabase uses: the `sub` claim of the request JWT.
create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- Sessions (Supabase Auth keeps one row per signed-in session).
create table auth.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Minimal Supabase Storage: buckets + objects with RLS enabled and the same
-- broad table grants Supabase gives the API roles (policies decide access).
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  created_at timestamptz default now(),
  metadata   jsonb
);

alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
