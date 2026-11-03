-- =============================================================================
-- Phase 6: basic customer master + verified customer product codes
--
-- No customer master existed (the Phase 1 Customers page was a placeholder).
-- This is the minimal table the PO workflow needs; it holds only records that
-- users create. Nothing is seeded. A PO may also carry an external customer
-- reference (name only) when no customer record is selected.
--
-- customer_product_codes: verified mappings "this customer's code -> our
-- product", created only when a user manually matches a PO line and chooses to
-- remember it. Used as matching rule 2.
-- =============================================================================

create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete restrict,
  customer_code text not null check (customer_code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  customer_name text not null check (length(btrim(customer_name)) between 1 and 200),
  contact_email text check (contact_email is null or (length(contact_email) <= 320 and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  notes         text check (notes is null or length(notes) <= 1000),
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint customers_company_code_unique unique (company_id, customer_code),
  constraint customers_id_company_unique unique (id, company_id)
);

create index if not exists customers_company_name_idx on public.customers (company_id, lower(customer_name));

create or replace function private.before_customer_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.customer_code := upper(btrim(new.customer_code));
  new.customer_name := btrim(regexp_replace(new.customer_name, '\s+', ' ', 'g'));
  new.contact_email := nullif(lower(btrim(coalesce(new.contact_email, ''))), '');
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
    new.customer_code := old.customer_code;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

create or replace function private.audit_customer_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.write_audit_log(new.company_id,
    case when tg_op = 'INSERT' then 'customer.created'
         when new.status is distinct from old.status then case when new.status = 'ACTIVE' then 'customer.activated' else 'customer.deactivated' end
         else 'customer.updated' end,
    'customer', new.id::text, jsonb_build_object('customer_code', new.customer_code, 'customer_name', new.customer_name));
  return null;
end;
$$;

revoke all on function private.before_customer_write() from public, anon, authenticated;
revoke all on function private.audit_customer_change() from public, anon, authenticated;

drop trigger if exists customers_before_write on public.customers;
create trigger customers_before_write before insert or update on public.customers
  for each row execute function private.before_customer_write();
drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at before update on public.customers
  for each row execute function private.set_updated_at();
drop trigger if exists customers_audit on public.customers;
create trigger customers_audit after insert or update on public.customers
  for each row execute function private.audit_customer_change();

alter table public.customers enable row level security;
revoke all on table public.customers from anon, authenticated;
grant all on table public.customers to service_role;
grant select on public.customers to authenticated;
grant insert (company_id, customer_code, customer_name, contact_email, status, notes) on public.customers to authenticated;
grant update (customer_name, contact_email, status, notes) on public.customers to authenticated;

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (private.has_permission(company_id, 'customers.read') or private.has_permission(company_id, 'customer_po.read'));
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers for insert to authenticated
  with check (private.has_permission(company_id, 'customers.manage'));
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update to authenticated
  using (private.has_permission(company_id, 'customers.manage'))
  with check (private.has_permission(company_id, 'customers.manage'));

-- -----------------------------------------------------------------------------
-- Verified customer product codes (written only by the matching RPC)
-- -----------------------------------------------------------------------------
create table if not exists public.customer_product_codes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete restrict,
  customer_id   uuid not null,
  customer_sku  text not null check (length(btrim(customer_sku)) between 1 and 100),
  product_id    uuid not null,
  verified_by   uuid,
  created_at    timestamptz not null default now(),
  constraint customer_product_codes_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint customer_product_codes_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict
);

create unique index if not exists customer_product_codes_unique on public.customer_product_codes (company_id, customer_id, upper(customer_sku));

alter table public.customer_product_codes enable row level security;
revoke all on table public.customer_product_codes from anon, authenticated;
grant select on public.customer_product_codes to authenticated;
grant all on table public.customer_product_codes to service_role;
drop policy if exists customer_product_codes_select on public.customer_product_codes;
create policy customer_product_codes_select on public.customer_product_codes for select to authenticated
  using (private.has_permission(company_id, 'customer_po.read') or private.has_permission(company_id, 'customers.read'));
