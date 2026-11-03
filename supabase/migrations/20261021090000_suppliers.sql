-- =============================================================================
-- Supplier master
--
-- No supplier table existed: the Suppliers page was a placeholder, and
-- outsourcing orders, stock lots and products each reserved a supplier column
-- "until the supplier master exists". This migration is ADDITIVE ONLY:
--
--   suppliers                       company-scoped supplier records (nothing seeded)
--   products.preferred_supplier_id  gets its same-company foreign key (the column
--                                   has been NULL-only until now, enforced by the
--                                   products trigger, so no existing row changes)
--   public.supplier_activity()      a supplier's audit history for users with
--                                   suppliers.read (audit_logs.read not required)
--   private.require_active_supplier() guard for the future supplier PO module:
--                                   valid, same-company, ACTIVE supplier only
--
-- Permissions: reuses suppliers.read / suppliers.manage from the seed RBAC
-- migration (ADMIN and PURCHASE_MANAGER manage, ACCOUNTS_MANAGER reads,
-- SUPER_ADMIN has everything). Reading requires suppliers.read only: other
-- roles (e.g. those with purchases.read) gain nothing from this migration.
--
-- Suppliers are never deleted by clients (no DELETE grant or policy); they are
-- deactivated instead so historical references stay intact.
--
-- Bank details are intentionally NOT stored here: this table is readable by
-- everyone with suppliers.read. Store them only once a
-- separately permissioned (payables) table exists.
-- =============================================================================

create table if not exists public.suppliers (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  supplier_code        text not null check (supplier_code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  legal_name           text not null check (length(btrim(legal_name)) between 1 and 200),
  display_name         text check (display_name is null or length(btrim(display_name)) between 1 and 200),
  category             text not null default 'OTHER'
                       check (category in ('RAW_MATERIAL', 'FINISHED_GOODS', 'PACKAGING', 'MACHINERY', 'SERVICES', 'OTHER')),
  contact_person       text check (contact_person is null or length(contact_person) <= 120),
  phone                text check (phone is null or (phone ~ '^\+?[0-9][0-9 -]{5,18}[0-9]$'
                                                    and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 7 and 15)),
  alternate_phone      text check (alternate_phone is null or (alternate_phone ~ '^\+?[0-9][0-9 -]{5,18}[0-9]$'
                                                    and length(regexp_replace(alternate_phone, '[^0-9]', '', 'g')) between 7 and 15)),
  email                text check (email is null or (length(email) <= 320 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  -- GSTIN is optional: unregistered, composition-exempt and overseas suppliers have none.
  gstin                text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan                  text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  billing_address      text check (billing_address is null or length(billing_address) <= 1000),
  shipping_address     text check (shipping_address is null or length(shipping_address) <= 1000),
  city                 text check (city is null or length(city) <= 100),
  -- GST state / UT code (public.gst_state_codes()).
  state_code           text check (state_code is null or state_code ~ '^[0-9]{2}$'),
  pin_code             text check (pin_code is null or pin_code ~ '^[A-Za-z0-9 -]{3,12}$'),
  country              text not null default 'India' check (length(btrim(country)) between 2 and 60),
  payment_terms        text not null default 'DAYS_30'
                       check (payment_terms in ('IMMEDIATE', 'DAYS_7', 'DAYS_15', 'DAYS_30', 'DAYS_45', 'CUSTOM')),
  custom_payment_days  integer check (custom_payment_days is null or custom_payment_days between 1 and 365),
  notes                text check (notes is null or length(notes) <= 2000),
  status               text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_by           uuid,
  updated_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint suppliers_company_code_unique unique (company_id, supplier_code),
  -- Target of composite (same-company) foreign keys from other tables.
  constraint suppliers_id_company_unique unique (id, company_id),
  constraint suppliers_custom_terms_check check ((payment_terms = 'CUSTOM') = (custom_payment_days is not null)),
  -- An Indian PIN code is 6 digits and does not start with 0.
  constraint suppliers_pin_india_check check (pin_code is null or country <> 'India' or pin_code ~ '^[1-9][0-9]{5}$'),
  -- Characters 3-12 of a GSTIN are the holder's PAN.
  constraint suppliers_gstin_pan_check check (gstin is null or pan is null or substr(gstin, 3, 10) = pan)
);

comment on table public.suppliers is
  'Supplier master (company-scoped). Never deleted by clients; deactivate instead. No bank details are stored here.';
comment on column public.suppliers.custom_payment_days is 'Required when payment_terms = CUSTOM, otherwise NULL.';

-- The same GSTIN cannot be registered twice in one company (main duplicate guard).
create unique index if not exists suppliers_company_gstin_unique on public.suppliers (company_id, gstin) where gstin is not null;
create index if not exists suppliers_company_name_idx on public.suppliers (company_id, lower(legal_name));
create index if not exists suppliers_company_status_idx on public.suppliers (company_id, status);

-- -----------------------------------------------------------------------------
-- Normalisation, code generation and immutable columns
-- -----------------------------------------------------------------------------
create or replace function private.before_supplier_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  new.legal_name := btrim(regexp_replace(coalesce(new.legal_name, ''), '\s+', ' ', 'g'));
  new.display_name := nullif(btrim(regexp_replace(coalesce(new.display_name, ''), '\s+', ' ', 'g')), '');
  new.contact_person := nullif(btrim(regexp_replace(coalesce(new.contact_person, ''), '\s+', ' ', 'g')), '');
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.alternate_phone := nullif(btrim(coalesce(new.alternate_phone, '')), '');
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.gstin := nullif(upper(btrim(coalesce(new.gstin, ''))), '');
  new.pan := nullif(upper(btrim(coalesce(new.pan, ''))), '');
  new.billing_address := nullif(btrim(coalesce(new.billing_address, '')), '');
  new.shipping_address := nullif(btrim(coalesce(new.shipping_address, '')), '');
  new.city := nullif(btrim(regexp_replace(coalesce(new.city, ''), '\s+', ' ', 'g')), '');
  new.state_code := nullif(btrim(coalesce(new.state_code, '')), '');
  new.pin_code := nullif(upper(btrim(coalesce(new.pin_code, ''))), '');
  new.country := coalesce(nullif(btrim(regexp_replace(coalesce(new.country, ''), '\s+', ' ', 'g')), ''), 'India');
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  if new.payment_terms is distinct from 'CUSTOM' then
    new.custom_payment_days := null;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.supplier_code := nullif(upper(btrim(coalesce(new.supplier_code, ''))), '');
    -- No code given: next free SUP-000001 style number for this company. The
    -- counter row is locked by next_document_number, so concurrent inserts get
    -- distinct numbers; the loop skips numbers already taken by manual codes.
    if new.supplier_code is null then
      loop
        v_code := private.next_document_number(new.company_id, 'SUP');
        exit when not exists (select 1 from public.suppliers s where s.company_id = new.company_id and s.supplier_code = v_code);
      end loop;
      new.supplier_code := v_code;
    end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.company_id := old.company_id;
    new.supplier_code := old.supplier_code;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Audit: what changed (field names only, never values) and status transitions.
create or replace function private.audit_supplier_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
  v_meta    jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into v_changed
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value and n.key not in ('updated_at', 'updated_by');
    if cardinality(v_changed) = 0 then
      return null;
    end if;
  end if;
  v_meta := jsonb_build_object('supplier_code', new.supplier_code, 'legal_name', new.legal_name);
  if tg_op = 'UPDATE' then
    v_meta := v_meta || jsonb_build_object('changed_fields', to_jsonb(v_changed));
    if new.status is distinct from old.status then
      v_meta := v_meta || jsonb_build_object('from', old.status, 'to', new.status);
    end if;
  end if;
  perform private.write_audit_log(new.company_id,
    case when tg_op = 'INSERT' then 'supplier.created'
         when new.status is distinct from old.status then case when new.status = 'ACTIVE' then 'supplier.activated' else 'supplier.deactivated' end
         else 'supplier.updated' end,
    'supplier', new.id::text, v_meta);
  return null;
end;
$$;

revoke all on function private.before_supplier_write() from public, anon, authenticated;
revoke all on function private.audit_supplier_change() from public, anon, authenticated;

drop trigger if exists suppliers_before_write on public.suppliers;
create trigger suppliers_before_write before insert or update on public.suppliers
  for each row execute function private.before_supplier_write();
drop trigger if exists suppliers_set_updated_at on public.suppliers;
create trigger suppliers_set_updated_at before update on public.suppliers
  for each row execute function private.set_updated_at();
drop trigger if exists suppliers_audit on public.suppliers;
create trigger suppliers_audit after insert or update on public.suppliers
  for each row execute function private.audit_supplier_change();

-- -----------------------------------------------------------------------------
-- Row Level Security and column grants
-- -----------------------------------------------------------------------------
alter table public.suppliers enable row level security;
revoke all on table public.suppliers from anon, authenticated;
grant all on table public.suppliers to service_role;
grant select on public.suppliers to authenticated;
grant insert (company_id, supplier_code, legal_name, display_name, category, contact_person, phone, alternate_phone, email, gstin, pan,
              billing_address, shipping_address, city, state_code, pin_code, country, payment_terms, custom_payment_days, notes, status)
  on public.suppliers to authenticated;
-- company_id and supplier_code are fixed after creation (the trigger also enforces it).
grant update (legal_name, display_name, category, contact_person, phone, alternate_phone, email, gstin, pan,
              billing_address, shipping_address, city, state_code, pin_code, country, payment_terms, custom_payment_days, notes, status)
  on public.suppliers to authenticated;

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated
  using (private.has_permission(company_id, 'suppliers.read'));
drop policy if exists suppliers_insert on public.suppliers;
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (private.has_permission(company_id, 'suppliers.manage'));
drop policy if exists suppliers_update on public.suppliers;
create policy suppliers_update on public.suppliers for update to authenticated
  using (private.has_permission(company_id, 'suppliers.manage'))
  with check (private.has_permission(company_id, 'suppliers.manage'));
-- No DELETE policy or grant: suppliers are deactivated, never deleted.

-- -----------------------------------------------------------------------------
-- Products: same-company foreign key for the reserved preferred supplier column.
-- Every existing value is NULL (the products trigger rejected anything else
-- until this table existed), so adding the constraint changes no data.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_preferred_supplier_fk') then
    alter table public.products add constraint products_preferred_supplier_fk
      foreign key (preferred_supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict;
  end if;
end;
$$;

create index if not exists products_preferred_supplier_idx on public.products (company_id, preferred_supplier_id) where preferred_supplier_id is not null;

comment on column public.products.preferred_supplier_id is
  'Preferred supplier (same-company foreign key to public.suppliers).';

-- -----------------------------------------------------------------------------
-- Supplier activity history (for the supplier detail page)
-- -----------------------------------------------------------------------------
create or replace function public.supplier_activity(p_supplier_id uuid)
returns table (id uuid, action text, event_timestamp timestamptz, actor_name text, metadata jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  select s.company_id into v_company from public.suppliers s where s.id = p_supplier_id;
  -- Same message whether the supplier is missing or in another company.
  if v_company is null or not private.has_permission(v_company, 'suppliers.read') then
    raise exception 'Supplier not found.' using errcode = 'P0001';
  end if;
  return query
    select a.id, a.action, a.event_timestamp,
           case when a.actor_user_id is null then null
                else coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1), 'Former user') end,
           a.metadata
    from public.audit_logs a
    left join public.profiles p on p.id = a.actor_user_id and p.company_id = v_company
    where a.company_id = v_company and a.resource_type = 'supplier' and a.resource_id = p_supplier_id::text
    order by a.event_timestamp desc
    limit 200;
end;
$$;

revoke all on function public.supplier_activity(uuid) from public, anon;
grant execute on function public.supplier_activity(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Guard for the future supplier purchase order module. Call it from the PO
-- create/update functions so a new PO can only reference a valid, ACTIVE,
-- same-company supplier. Existing POs keep their supplier through a composite
-- (supplier_id, company_id) foreign key to suppliers_id_company_unique.
-- -----------------------------------------------------------------------------
create or replace function private.require_active_supplier(p_company uuid, p_supplier_id uuid)
returns public.suppliers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_supplier public.suppliers;
begin
  select * into v_supplier from public.suppliers s where s.id = p_supplier_id and s.company_id = p_company;
  if not found then
    raise exception 'Select a valid supplier.' using errcode = 'P0001';
  end if;
  if v_supplier.status <> 'ACTIVE' then
    raise exception 'Supplier % is inactive and cannot be used for new purchase orders.', v_supplier.supplier_code using errcode = 'P0001';
  end if;
  return v_supplier;
end;
$$;

revoke all on function private.require_active_supplier(uuid, uuid) from public, anon, authenticated;
