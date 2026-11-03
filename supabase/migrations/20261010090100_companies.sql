-- =============================================================================
-- Companies and company settings.
-- Every company-specific record in this and future phases carries company_id
-- and is scoped by RLS, so additional companies can be added later safely.
-- =============================================================================

create table if not exists public.companies (
  id            uuid primary key default gen_random_uuid(),
  legal_name    text not null check (length(btrim(legal_name)) between 2 and 200),
  display_name  text not null check (length(btrim(display_name)) between 2 and 200),
  company_code  text not null unique check (company_code ~ '^[A-Z0-9_-]{2,20}$'),
  legal_address text check (legal_address is null or length(legal_address) <= 1000),
  state         text check (state is null or length(state) <= 100),
  country       text check (country is null or length(country) <= 100),
  -- Nullable until the company configures it. Standard 15-character GSTIN format.
  gstin         text unique check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  currency_code text not null default 'INR' check (currency_code ~ '^[A-Z]{3}$'),
  timezone      text not null default 'Asia/Kolkata',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.companies is 'Legal entities using the ERP. Company-scoped data references companies.id.';

-- Timezone must be a real IANA zone (a CHECK cannot query pg_timezone_names).
create or replace function private.validate_company_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_company_timezone() from public, anon, authenticated;

drop trigger if exists companies_validate_timezone on public.companies;
create trigger companies_validate_timezone
  before insert or update of timezone on public.companies
  for each row execute function private.validate_company_timezone();

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------

create table if not exists public.company_settings (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  setting_key   text not null check (setting_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(setting_key) <= 100),
  setting_value jsonb not null default 'null'::jsonb check (pg_column_size(setting_value) <= 16384),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint company_settings_company_key_unique unique (company_id, setting_key)
);

comment on table public.company_settings is 'Per-company key/value configuration (JSONB values). Readable and writable only with settings.manage.';

drop trigger if exists company_settings_set_updated_at on public.company_settings;
create trigger company_settings_set_updated_at
  before update on public.company_settings
  for each row execute function private.set_updated_at();
