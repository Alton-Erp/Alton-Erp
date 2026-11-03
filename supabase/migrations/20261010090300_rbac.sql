-- =============================================================================
-- Role-based access control: roles, permissions, role_permissions, user_roles.
-- The role and permission catalogue is seeded by migration and is read-only to
-- clients. Role assignments are company-scoped.
-- =============================================================================

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z][A-Z_]{1,49}$'),
  name        text not null check (length(btrim(name)) between 2 and 100),
  description text check (description is null or length(description) <= 500),
  is_system   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists roles_set_updated_at on public.roles;
create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function private.set_updated_at();

create table if not exists public.permissions (
  id          uuid primary key default gen_random_uuid(),
  resource    text not null check (resource ~ '^[a-z][a-z_]{1,49}$'),
  action      text not null check (action ~ '^[a-z][a-z_]{1,49}$'),
  code        text generated always as (resource || '.' || action) stored,
  description text check (description is null or length(description) <= 500),
  created_at  timestamptz not null default now(),
  constraint permissions_code_unique unique (code)
);

create table if not exists public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create index if not exists role_permissions_permission_id_idx on public.role_permissions (permission_id);

create table if not exists public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  company_id  uuid not null references public.companies (id) on delete cascade,
  role_id     uuid not null references public.roles (id) on delete restrict,
  assigned_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint user_roles_unique unique (user_id, company_id, role_id),
  -- Validates the assignment against the user's actual company membership.
  -- Also blocks moving a user to another company while roles remain assigned.
  constraint user_roles_membership_fk foreign key (user_id, company_id)
    references public.profiles (id, company_id) on delete cascade
);

comment on table public.user_roles is 'Company-scoped role assignments. Composite FK guarantees the user belongs to company_id.';

create index if not exists user_roles_company_id_idx on public.user_roles (company_id);
create index if not exists user_roles_role_id_idx on public.user_roles (role_id);
