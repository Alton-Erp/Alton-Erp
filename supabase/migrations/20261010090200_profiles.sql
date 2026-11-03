-- =============================================================================
-- User profiles, one per auth.users row.
--
-- Profiles are created by a trigger on auth.users. New profiles are INACTIVE and
-- have NO company: nothing a client sends at signup (metadata, role names,
-- company ids, flags) is trusted, apart from an optional display name.
-- Access is granted only when an administrator (or the trusted bootstrap
-- procedure) assigns a company, activates the profile and assigns roles.
-- =============================================================================

-- Preflight: many Supabase starter templates create their own public.profiles.
-- Fail with a clear message instead of silently skipping table creation.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles')
     and not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'company_id'
     ) then
    raise exception 'public.profiles already exists with a different structure. Review and migrate it manually before applying this migration (see docs/SUPABASE_SETUP.md).';
  end if;
end;
$$;

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text check (full_name is null or length(btrim(full_name)) between 1 and 120),
  email      text not null check (length(email) <= 320),
  company_id uuid references public.companies (id) on delete restrict,
  is_active  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the composite foreign key on user_roles: a role can only be
  -- assigned within the company the user actually belongs to.
  constraint profiles_id_company_unique unique (id, company_id),
  -- An active profile must belong to a company.
  constraint profiles_active_requires_company check (not is_active or company_id is not null)
);

comment on table public.profiles is 'ERP user profile. id = auth.users.id. Inactive and company-less until provisioned by an administrator.';

create index if not exists profiles_company_id_idx on public.profiles (company_id);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- Profile creation on new auth user (SECURITY DEFINER: runs inside Supabase Auth).
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120)), '');
begin
  insert into public.profiles (id, email, full_name, company_id, is_active)
  values (new.id, coalesce(new.email, ''), v_name, null, false)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Keep the profile email in sync when a user's verified email changes.
create or replace function private.sync_auth_user_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

revoke all on function private.sync_auth_user_email() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function private.sync_auth_user_email();
