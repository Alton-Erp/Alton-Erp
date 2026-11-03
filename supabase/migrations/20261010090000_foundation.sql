-- =============================================================================
-- Foundation: private helper schema and shared trigger functions.
--
-- Conventions used by every migration in this project:
--   * UUID primary keys (gen_random_uuid(), built into PostgreSQL 13+).
--   * TIMESTAMPTZ columns, stored in UTC; the UI converts to the company timezone.
--   * RLS enabled on every application table, with explicit grants (no reliance
--     on Supabase's default "grant all to anon/authenticated").
--   * Idempotent DDL (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS on
--     policies and triggers only) so a migration can be re-applied safely.
--     No migration drops a table or deletes business data.
-- =============================================================================

-- Functions in `private` are used by RLS policies. The schema is NOT exposed
-- through the Data API (only `public` is), so these cannot be called as RPCs.
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
grant usage on schema private to authenticated, service_role;

-- Keeps updated_at current on every UPDATE.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;
