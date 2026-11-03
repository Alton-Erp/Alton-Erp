-- =============================================================================
-- Phase 3: Product Master
--   * Granular product permissions + role grants
--   * product_categories and products (company-scoped)
--   * Validation, guard and audit triggers
--   * RLS + minimal column-level grants
--   * Read helpers (KPIs, category counts, identifier lookup) and import logging
--   * Suggested categories for the ALTON company (only if missing)
--
-- The products table deliberately has NO stock / quantity columns. Inventory
-- balances belong to the Phase 4 inventory ledger. default_source_type is the
-- product's normal sourcing strategy, not the source of any stock unit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('products',           'create', 'Create products'),
  ('products',           'update', 'Edit product details'),
  ('products',           'archive','Activate, deactivate and archive products'),
  ('products',           'import', 'Bulk-import products from spreadsheets'),
  ('products',           'export', 'Export product data'),
  ('product_categories', 'manage', 'Create and edit product categories')
on conflict (code) do nothing;

comment on table public.permissions is
  'Permission catalogue. products.manage (Phase 2) is superseded by the granular products.* permissions and is no longer checked by any policy.';

with matrix (role_code, permission_code) as (
  values
    ('ADMIN', 'products.create'), ('ADMIN', 'products.update'), ('ADMIN', 'products.archive'),
    ('ADMIN', 'products.import'), ('ADMIN', 'products.export'), ('ADMIN', 'product_categories.manage'),

    ('INVENTORY_MANAGER', 'products.create'), ('INVENTORY_MANAGER', 'products.update'),
    ('INVENTORY_MANAGER', 'products.archive'), ('INVENTORY_MANAGER', 'products.import'),
    ('INVENTORY_MANAGER', 'products.export'), ('INVENTORY_MANAGER', 'product_categories.manage'),

    ('PURCHASE_MANAGER', 'products.export'),
    ('SALES_MANAGER', 'products.export'),
    ('ACCOUNTS_MANAGER', 'products.read'), ('ACCOUNTS_MANAGER', 'products.export'),
    ('MANAGEMENT_VIEWER', 'products.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from matrix m
join public.roles r on r.code = m.role_code
join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. product_categories
-- -----------------------------------------------------------------------------
create table if not exists public.product_categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 100 and name = btrim(name)),
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  description text check (description is null or length(description) <= 500),
  is_active   boolean not null default true,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint product_categories_company_code_unique unique (company_id, code),
  -- Target of the composite FK from products (same-company category references).
  constraint product_categories_id_company_unique unique (id, company_id)
);

-- Names are unique per company, case-insensitively.
create unique index if not exists product_categories_company_name_unique
  on public.product_categories (company_id, lower(name));

comment on table public.product_categories is 'Company-scoped product categories. Never deleted; deactivate instead.';

-- -----------------------------------------------------------------------------
-- 3. products
-- -----------------------------------------------------------------------------
create table if not exists public.products (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,

  -- Identification
  sku                   text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$'),
  product_name          text not null check (length(btrim(product_name)) between 1 and 200),
  description           text check (description is null or length(description) <= 2000),
  category_id           uuid,
  brand                 text check (brand is null or length(btrim(brand)) between 1 and 100),
  model_number          text check (model_number is null or length(btrim(model_number)) between 1 and 100),
  barcode               text check (barcode is null or barcode ~ '^[A-Za-z0-9-]{4,64}$'),
  product_image_path    text check (product_image_path is null or length(product_image_path) <= 500),
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  archived_at           timestamptz,
  archived_by           uuid,

  -- Classification
  product_type          text not null check (product_type in ('RAW_MATERIAL', 'FINISHED_GOOD', 'COMPONENT', 'PACKAGING_MATERIAL', 'OTHER')),
  default_source_type   text not null check (default_source_type in ('IN_HOUSE', 'OUTSOURCED', 'HYBRID')),
  base_unit             text not null check (base_unit ~ '^[A-Z]{1,10}$'),
  track_batches         boolean not null default false,
  track_expiry          boolean not null default false,

  -- Commercial (all optional until confirmed)
  hsn_code              text check (hsn_code is null or hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  gst_rate              numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  selling_price         numeric(14,2) check (selling_price is null or selling_price >= 0),
  standard_cost         numeric(14,2) check (standard_cost is null or standard_cost >= 0),
  minimum_selling_price numeric(14,2) check (minimum_selling_price is null or minimum_selling_price >= 0),
  reorder_level         numeric(14,3) check (reorder_level is null or reorder_level >= 0),
  -- Supplier master does not exist yet. The FK (same-company) is added by the
  -- supplier migration in a later phase; until then the app never sets this.
  preferred_supplier_id uuid,

  -- Manufacturing
  is_manufacturable     boolean not null default false,
  has_bom               boolean not null default false,
  production_notes      text check (production_notes is null or length(production_notes) <= 2000),

  -- Audit (set by trigger, not by clients)
  created_by            uuid,
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint products_min_price_le_selling check (
    minimum_selling_price is null or selling_price is null or minimum_selling_price <= selling_price),
  constraint products_archived_is_inactive check (archived_at is null or status = 'INACTIVE'),
  constraint products_expiry_requires_batches check (not track_expiry or track_batches),
  -- Category must belong to the same company (MATCH SIMPLE: NULL category allowed).
  constraint products_category_same_company_fk foreign key (category_id, company_id)
    references public.product_categories (id, company_id) on delete restrict
);

comment on table public.products is
  'Product master. Contains no stock quantities: balances are maintained by the inventory ledger (Phase 4). default_source_type is the normal sourcing strategy only.';
comment on column public.products.default_source_type is
  'Normal sourcing strategy (IN_HOUSE / OUTSOURCED / HYBRID). The actual source of each stock unit is recorded on inventory receipts/batches.';
comment on column public.products.preferred_supplier_id is
  'Reserved for the supplier master. Foreign key added when public.suppliers is created.';

-- SKU and barcode uniqueness per company (SKU case-insensitive).
create unique index if not exists products_company_sku_unique on public.products (company_id, lower(sku));
create unique index if not exists products_company_barcode_unique on public.products (company_id, barcode) where barcode is not null;

create index if not exists products_company_status_idx on public.products (company_id, status);
create index if not exists products_company_category_idx on public.products (company_id, category_id);
create index if not exists products_company_source_idx on public.products (company_id, default_source_type);
create index if not exists products_company_type_idx on public.products (company_id, product_type);
create index if not exists products_company_updated_idx on public.products (company_id, updated_at desc);
create index if not exists products_company_name_idx on public.products (company_id, lower(product_name));

-- -----------------------------------------------------------------------------
-- 4. Trigger functions
-- -----------------------------------------------------------------------------

-- Placeholder: whether any downstream record (stock, orders, production,
-- invoices) references the product. Later phases REPLACE this function with
-- real checks; until then no downstream tables exist.
create or replace function private.product_has_transactions(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false;
$$;

revoke all on function private.product_has_transactions(uuid) from public, anon;
grant execute on function private.product_has_transactions(uuid) to authenticated;

create or replace function private.is_client_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('authenticated', 'anon');
$$;

revoke all on function private.is_client_role() from public, anon;
grant execute on function private.is_client_role() to authenticated;

-- Normalisation + audit ownership for categories. SECURITY DEFINER so the
-- active-products check sees all of the company's products, not only those
-- visible to the caller under RLS.
create or replace function private.before_product_category_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  new.code := upper(btrim(new.code));
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    new.code := old.code;               -- code is immutable
    new.company_id := old.company_id;   -- company is immutable
  end if;
  new.updated_by := auth.uid();

  -- Business rule: a category cannot be deactivated while ACTIVE products use it.
  if tg_op = 'UPDATE' and old.is_active and not new.is_active then
    if exists (select 1 from public.products p where p.category_id = old.id and p.status = 'ACTIVE') then
      raise exception 'This category still has active products. Reassign or deactivate those products first.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.before_product_category_write() from public, anon, authenticated;

drop trigger if exists product_categories_before_write on public.product_categories;
create trigger product_categories_before_write
  before insert or update on public.product_categories
  for each row execute function private.before_product_category_write();

drop trigger if exists product_categories_set_updated_at on public.product_categories;
create trigger product_categories_set_updated_at
  before update on public.product_categories
  for each row execute function private.set_updated_at();

-- Normalisation, guards and audit ownership for products.
create or replace function private.before_product_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_detail_changed boolean;
  v_status_changed boolean;
begin
  -- Normalise optional text: empty strings become NULL; barcode/HSN trimmed.
  new.barcode       := nullif(btrim(coalesce(new.barcode, '')), '');
  new.hsn_code      := nullif(btrim(coalesce(new.hsn_code, '')), '');
  new.brand         := nullif(btrim(coalesce(new.brand, '')), '');
  new.model_number  := nullif(btrim(coalesce(new.model_number, '')), '');
  new.description   := nullif(btrim(coalesce(new.description, '')), '');
  new.production_notes := nullif(btrim(coalesce(new.production_notes, '')), '');
  new.base_unit     := upper(btrim(new.base_unit));

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.archived_at := null;
    new.archived_by := null;
    if new.status is null then new.status := 'ACTIVE'; end if;
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
  end if;
  new.updated_by := auth.uid();

  -- Archive bookkeeping: timestamp and actor are set here, never by clients.
  if tg_op = 'UPDATE' then
    if new.archived_at is not null and old.archived_at is null then
      new.archived_at := now();
      new.archived_by := auth.uid();
    elsif new.archived_at is null then
      new.archived_by := null;
    else
      new.archived_at := old.archived_at;
      new.archived_by := old.archived_by;
    end if;
  end if;

  -- Category must be active when it is assigned (existing references are kept).
  if new.category_id is not null
     and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id)
     and not exists (select 1 from public.product_categories c
                     where c.id = new.category_id and c.company_id = new.company_id and c.is_active) then
    raise exception 'The selected category is inactive or does not exist.' using errcode = 'P0001';
  end if;

  -- Preferred supplier cannot be set until the supplier master exists.
  if new.preferred_supplier_id is not null
     and (tg_op = 'INSERT' or new.preferred_supplier_id is distinct from old.preferred_supplier_id)
     and to_regclass('public.suppliers') is null then
    raise exception 'Preferred supplier cannot be set before the supplier master is available.' using errcode = 'P0001';
  end if;

  -- Image path must live in this product's own storage folder.
  if new.product_image_path is not null
     and (tg_op = 'INSERT' or new.product_image_path is distinct from old.product_image_path)
     and (tg_op = 'INSERT' or new.product_image_path not like new.company_id::text || '/' || new.id::text || '/%') then
    raise exception 'Invalid product image path.' using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' and private.is_client_role() then
    -- SKU is a critical identifier once downstream records exist.
    if new.sku is distinct from old.sku and private.product_has_transactions(old.id) then
      raise exception 'The SKU cannot be changed because transactions already reference this product.'
        using errcode = 'P0001';
    end if;

    v_status_changed := new.status is distinct from old.status or new.archived_at is distinct from old.archived_at;
    v_detail_changed := (to_jsonb(new) - array['status','archived_at','archived_by','updated_at','updated_by'])
                        is distinct from (to_jsonb(old) - array['status','archived_at','archived_by','updated_at','updated_by']);

    if v_status_changed and not private.has_permission(old.company_id, 'products.archive') then
      raise exception 'You are not allowed to change product status.' using errcode = '42501';
    end if;
    if v_detail_changed and not private.has_permission(old.company_id, 'products.update') then
      raise exception 'You are not allowed to edit product details.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.before_product_write() from public, anon, authenticated;

drop trigger if exists products_before_write on public.products;
create trigger products_before_write
  before insert or update on public.products
  for each row execute function private.before_product_write();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function private.set_updated_at();

-- Audit: products
create or replace function private.audit_product_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.write_audit_log(new.company_id, 'product.created', 'product', new.id::text,
      jsonb_build_object('sku', new.sku));
    return null;
  end if;

  if new.status is distinct from old.status then
    perform private.write_audit_log(new.company_id,
      case when new.status = 'ACTIVE' then 'product.activated' else 'product.deactivated' end,
      'product', new.id::text, jsonb_build_object('sku', new.sku));
  end if;

  if new.archived_at is distinct from old.archived_at then
    perform private.write_audit_log(new.company_id,
      case when new.archived_at is null then 'product.unarchived' else 'product.archived' end,
      'product', new.id::text, jsonb_build_object('sku', new.sku));
  end if;

  if new.sku is distinct from old.sku then
    perform private.write_audit_log(new.company_id, 'product.sku_changed', 'product', new.id::text,
      jsonb_build_object('from', old.sku, 'to', new.sku));
  end if;

  select coalesce(jsonb_agg(n.key order by n.key), '[]'::jsonb) into v_changed
  from jsonb_each(to_jsonb(new)) n
  join jsonb_each(to_jsonb(old)) o using (key)
  where n.value is distinct from o.value
    and n.key not in ('updated_at', 'updated_by', 'status', 'archived_at', 'archived_by', 'sku');

  if jsonb_array_length(v_changed) > 0 then
    perform private.write_audit_log(new.company_id, 'product.updated', 'product', new.id::text,
      jsonb_build_object('sku', new.sku, 'changed_fields', v_changed));
  end if;
  return null;
end;
$$;

revoke all on function private.audit_product_change() from public, anon, authenticated;

drop trigger if exists products_audit on public.products;
create trigger products_audit
  after insert or update on public.products
  for each row execute function private.audit_product_change();

-- Audit: categories
create or replace function private.audit_product_category_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit_log(new.company_id, 'product_category.created', 'product_category', new.id::text,
      jsonb_build_object('code', new.code));
  elsif new.is_active is distinct from old.is_active then
    perform private.write_audit_log(new.company_id,
      case when new.is_active then 'product_category.activated' else 'product_category.deactivated' end,
      'product_category', new.id::text, jsonb_build_object('code', new.code));
  elsif new.name is distinct from old.name or new.description is distinct from old.description then
    perform private.write_audit_log(new.company_id, 'product_category.updated', 'product_category', new.id::text,
      jsonb_build_object('code', new.code));
  end if;
  return null;
end;
$$;

revoke all on function private.audit_product_category_change() from public, anon, authenticated;

drop trigger if exists product_categories_audit on public.product_categories;
create trigger product_categories_audit
  after insert or update on public.product_categories
  for each row execute function private.audit_product_category_change();

-- -----------------------------------------------------------------------------
-- 5. RLS and grants
-- -----------------------------------------------------------------------------
alter table public.product_categories enable row level security;
alter table public.products enable row level security;

revoke all on table public.product_categories, public.products from anon, authenticated;
grant all on table public.product_categories, public.products to service_role;

-- Categories: no DELETE (deactivate instead); code/company immutable.
grant select on public.product_categories to authenticated;
grant insert (company_id, name, code, description, is_active) on public.product_categories to authenticated;
grant update (name, description, is_active) on public.product_categories to authenticated;

drop policy if exists product_categories_select on public.product_categories;
create policy product_categories_select on public.product_categories
  for select to authenticated
  using (private.has_permission(company_id, 'products.read')
         or private.has_permission(company_id, 'product_categories.manage'));

drop policy if exists product_categories_insert on public.product_categories;
create policy product_categories_insert on public.product_categories
  for insert to authenticated
  with check (private.has_permission(company_id, 'product_categories.manage'));

drop policy if exists product_categories_update on public.product_categories;
create policy product_categories_update on public.product_categories
  for update to authenticated
  using (private.has_permission(company_id, 'product_categories.manage'))
  with check (private.has_permission(company_id, 'product_categories.manage'));

-- Products: never deleted by clients; company_id and audit columns not writable.
grant select on public.products to authenticated;
grant insert (
  company_id, sku, product_name, description, category_id, brand, model_number, barcode,
  status, product_type, default_source_type, base_unit, track_batches, track_expiry,
  hsn_code, gst_rate, selling_price, standard_cost, minimum_selling_price, reorder_level,
  is_manufacturable, has_bom, production_notes
) on public.products to authenticated;
grant update (
  sku, product_name, description, category_id, brand, model_number, barcode, product_image_path,
  status, archived_at, product_type, default_source_type, base_unit, track_batches, track_expiry,
  hsn_code, gst_rate, selling_price, standard_cost, minimum_selling_price, reorder_level,
  is_manufacturable, has_bom, production_notes
) on public.products to authenticated;

drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated
  using (private.has_permission(company_id, 'products.read'));

drop policy if exists products_insert on public.products;
create policy products_insert on public.products
  for insert to authenticated
  with check (private.has_permission(company_id, 'products.create'));

-- Row access for UPDATE needs update OR archive; the trigger then checks which
-- kind of change (details vs status) the caller is allowed to make.
drop policy if exists products_update on public.products;
create policy products_update on public.products
  for update to authenticated
  using (private.has_permission(company_id, 'products.update')
         or private.has_permission(company_id, 'products.archive'))
  with check (private.has_permission(company_id, 'products.update')
              or private.has_permission(company_id, 'products.archive'));

-- -----------------------------------------------------------------------------
-- 6. Read helpers (SECURITY INVOKER: results are limited by RLS)
-- -----------------------------------------------------------------------------
create or replace function public.product_kpis()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'active',      count(*) filter (where status = 'ACTIVE'),
    'in_house',    count(*) filter (where status = 'ACTIVE' and default_source_type = 'IN_HOUSE'),
    'outsourced',  count(*) filter (where status = 'ACTIVE' and default_source_type = 'OUTSOURCED'),
    'hybrid',      count(*) filter (where status = 'ACTIVE' and default_source_type = 'HYBRID'),
    'inactive',    count(*) filter (where status = 'INACTIVE' and archived_at is null),
    'archived',    count(*) filter (where archived_at is not null),
    'total',       count(*)
  )
  from public.products
  where company_id = private.current_company_id();
$$;

create or replace function public.product_category_counts()
returns table (category_id uuid, total_products bigint, active_products bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.category_id, count(*), count(*) filter (where p.status = 'ACTIVE')
  from public.products p
  where p.company_id = private.current_company_id() and p.category_id is not null
  group by p.category_id;
$$;

-- Which of the given SKUs / barcodes already exist in the caller's company
-- (SKU compared case-insensitively). Used by the import preview.
create or replace function public.check_product_identifiers(p_skus text[], p_barcodes text[])
returns table (kind text, value text, product_id uuid, sku text)
language sql
stable
security invoker
set search_path = ''
as $$
  select 'sku', p.sku, p.id, p.sku
  from public.products p
  where p.company_id = private.current_company_id()
    and lower(p.sku) in (select lower(btrim(s)) from unnest(coalesce(p_skus, '{}')) s)
  union all
  select 'barcode', p.barcode, p.id, p.sku
  from public.products p
  where p.company_id = private.current_company_id()
    and p.barcode in (select btrim(b) from unnest(coalesce(p_barcodes, '{}')) b);
$$;

revoke all on function public.product_kpis() from public, anon;
revoke all on function public.product_category_counts() from public, anon;
revoke all on function public.check_product_identifiers(text[], text[]) from public, anon;
grant execute on function public.product_kpis() to authenticated;
grant execute on function public.product_category_counts() to authenticated;
grant execute on function public.check_product_identifiers(text[], text[]) to authenticated;

-- Display names (only) of colleagues in the caller's active company, for
-- "created by / updated by" labels. Returns nothing for other companies' users
-- and nothing at all for inactive callers. No emails or other profile fields.
create or replace function public.user_display_names(p_user_ids uuid[])
returns table (user_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(p.full_name, split_part(p.email, '@', 1))
  from public.profiles p
  where p.id = any (coalesce(p_user_ids, '{}'))
    and p.company_id = private.current_company_id()
  limit 200;
$$;

revoke all on function public.user_display_names(uuid[]) from public, anon;
grant execute on function public.user_display_names(uuid[]) to authenticated;

-- Records an import summary (requires products.import). Individual products
-- are audited by the products trigger.
create or replace function public.log_product_import(
  p_file_name text, p_total int, p_imported int, p_skipped int, p_failed int
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null or not private.has_permission(v_company, 'products.import') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  perform private.write_audit_log(v_company, 'product.import_completed', 'product_import', null,
    jsonb_build_object(
      'file_name', left(coalesce(p_file_name, ''), 200),
      'total_rows', greatest(coalesce(p_total, 0), 0),
      'imported', greatest(coalesce(p_imported, 0), 0),
      'skipped', greatest(coalesce(p_skipped, 0), 0),
      'failed', greatest(coalesce(p_failed, 0), 0)));
end;
$$;

revoke all on function public.log_product_import(text, int, int, int, int) from public, anon;
grant execute on function public.log_product_import(text, int, int, int, int) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Suggested categories for ALTON (editable; only inserted if missing)
-- -----------------------------------------------------------------------------
insert into public.product_categories (company_id, code, name, description)
select c.id, v.code, v.name, v.description
from public.companies c
cross join (values
  ('WASH_BASINS',     'Wash Basins',                 'Suggested category — edit or deactivate as needed.'),
  ('WATER_CLOSETS',   'Water Closets / Toilets',     'Suggested category — edit or deactivate as needed.'),
  ('URINALS',         'Urinals',                     'Suggested category — edit or deactivate as needed.'),
  ('BATH_ACCESSORIES','Bathroom Accessories',        'Suggested category — edit or deactivate as needed.'),
  ('CISTERNS_FLUSH',  'Cisterns and Flush Systems',  'Suggested category — edit or deactivate as needed.'),
  ('SW_COMPONENTS',   'Sanitary Ware Components',    'Suggested category — edit or deactivate as needed.'),
  ('RAW_MATERIALS',   'Raw Materials',               'Suggested category — edit or deactivate as needed.'),
  ('PACKAGING',       'Packaging Materials',         'Suggested category — edit or deactivate as needed.'),
  ('OTHER',           'Other Products',              'Suggested category — edit or deactivate as needed.')
) as v (code, name, description)
where c.company_code = 'ALTON'
on conflict do nothing;
