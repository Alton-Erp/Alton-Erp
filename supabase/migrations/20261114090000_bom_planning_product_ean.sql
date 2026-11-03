-- =============================================================================
-- ALTON ERP V2 — BOM planning fields and Product Master EAN
--
-- Inspected first; reused where the field already exists:
--   BOM "Product Name"       -> products.product_name (the BOM's finished product)
--   BOM "Product Type"       -> products.product_type
--   BOM "Tax Rate (%)"       -> products.gst_rate
--   BOM "Lead Time (Days)"   -> products.lead_time_days
-- The planning fields describe the finished product, not one BOM version (BOM
-- versions are immutable once approved), so they stay on the product and the
-- BOM screen edits the product's values (products.update permission).
--
-- Added (only what was missing):
--   products.group_head          text, optional; choices = ERP setting
--                                "product.group_heads" + values already in use
--   products.minimum_cover_days  numeric(7,2), optional, 0..3650. Informational:
--                                no stock, reorder or planning calculation uses it.
--   products.ean                 text, optional; EAN-8 or EAN-13 digits with a
--                                valid check digit; unique per company (index)
--   private.ean_valid(text)      the check-digit rule
--   ERP setting product.group_heads (list of names) with validation
--   public.product_group_head_options()  configured + in-use group heads
--   public.bom_list_v2           bom_list plus the product planning fields
-- No existing data is changed; existing products keep NULL in the new columns.
-- Rollback: supabase/rollback/20261114090000_bom_planning_product_ean_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. EAN check digit (GS1): weights 3,1,3,... from the digit left of the check digit
-- -----------------------------------------------------------------------------
create or replace function private.ean_valid(p_ean text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ean ~ '^([0-9]{8}|[0-9]{13})$'
    and (10 - (select sum(substr(p_ean, length(p_ean) - i, 1)::int * case when i % 2 = 1 then 3 else 1 end)
               from generate_series(1, length(p_ean) - 1) i) % 10) % 10 = substr(p_ean, length(p_ean), 1)::int;
$$;

grant execute on function private.ean_valid(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. products: new optional columns
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists ean text;
alter table public.products add column if not exists group_head text;
alter table public.products add column if not exists minimum_cover_days numeric(7,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_ean_format') then
    alter table public.products add constraint products_ean_format
      check (ean is null or private.ean_valid(ean));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_group_head_length') then
    alter table public.products add constraint products_group_head_length
      check (group_head is null or (group_head = btrim(group_head) and length(group_head) between 1 and 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_minimum_cover_days_range') then
    alter table public.products add constraint products_minimum_cover_days_range
      check (minimum_cover_days is null or minimum_cover_days between 0 and 3650);
  end if;
end;
$$;

-- Uniqueness and search by EAN within a company.
create unique index if not exists products_company_ean_unique on public.products (company_id, ean) where ean is not null;
create index if not exists products_company_group_head_idx on public.products (company_id, group_head) where group_head is not null;

comment on column public.products.ean is 'European Article Number (EAN-8 or EAN-13, check digit verified). Optional; unique within the company.';
comment on column public.products.group_head is 'Product group classification (Group Head). Optional; choices from ERP Settings and values in use.';
comment on column public.products.minimum_cover_days is 'Minimum inventory coverage in days (optional, informational). Not used by stock, reorder or planning calculations.';

grant insert (ean, group_head, minimum_cover_days) on public.products to authenticated;
grant update (ean, group_head, minimum_cover_days) on public.products to authenticated;

-- -----------------------------------------------------------------------------
-- 3. ERP setting: configurable group heads
-- -----------------------------------------------------------------------------
create or replace function private.erp_setting_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'general.date_format', 'DD MMM YYYY',
    'numbering.po_prefix', 'PO',
    'numbering.grn_prefix', 'GRN',
    'numbering.production_prefix', 'PRD',
    'numbering.sales_order_prefix', 'SO',
    'product.auto_sku', true,
    'product.sku_prefixes', jsonb_build_object('FINISHED_GOOD', 'FG', 'RAW_MATERIAL', 'RM', 'COMPONENT', 'CMP', 'SUBASSEMBLY', 'SUB',
      'OUTSOURCED_COMPONENT', 'OSC', 'PACKAGING_MATERIAL', 'PKG', 'CONSUMABLE', 'CON', 'OTHER', 'ITM'),
    'product.units', jsonb_build_array('PCS', 'NOS', 'SET', 'PAIR', 'BOX', 'KG', 'G', 'LTR', 'ML', 'MTR', 'SQM'),
    'product.default_gst_rate', 18,
    'product.hsn_codes', '[]'::jsonb,
    'product.group_heads', '[]'::jsonb,
    'inventory.adjustment_reasons', jsonb_build_array('Damaged', 'Count correction', 'Expired', 'Sample issued', 'Found in stock', 'Other'),
    'purchase.default_payment_terms', 'DAYS_30',
    'purchase.default_delivery_terms', null,
    'production.default_wastage_percent', 0,
    'production.consumption_prefill', 'STANDARD',
    'sales.default_payment_terms', null,
    'sales.default_delivery_instructions', null,
    'sales.default_warehouse_id', null,
    'import.date_order', 'DMY');
$$;

revoke all on function private.erp_setting_defaults() from public, anon, authenticated;

-- erp_settings_save validates known keys inline; the new key is validated here
-- (whatever path writes it).
create or replace function private.company_settings_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.setting_key = 'product.group_heads' and not (
       jsonb_typeof(new.setting_value) = 'array' and jsonb_array_length(new.setting_value) <= 200
       and not exists (select 1 from jsonb_array_elements(new.setting_value) e
                       where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 100)
       and (select count(*) from jsonb_array_elements_text(new.setting_value) e)
           = (select count(distinct lower(btrim(e))) from jsonb_array_elements_text(new.setting_value) e)) then
    raise exception 'Group heads: up to 200 different names of 1 to 100 characters.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.company_settings_validate() from public, anon, authenticated;

drop trigger if exists company_settings_validate on public.company_settings;
create trigger company_settings_validate
  before insert or update on public.company_settings
  for each row execute function private.company_settings_validate();

-- Group head choices: configured list first, then other values already in use.
create or replace function public.product_group_head_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.read');
  v_config  jsonb := coalesce(private.erp_setting(v_company, 'product.group_heads'), '[]'::jsonb);
begin
  if jsonb_typeof(v_config) <> 'array' then v_config := '[]'::jsonb; end if;
  return jsonb_build_object(
    'configured', v_config,
    'in_use', coalesce((
      select jsonb_agg(g order by lower(g)) from (
        select distinct p.group_head g from public.products p
        where p.company_id = v_company and p.group_head is not null
          and lower(p.group_head) not in (select lower(btrim(e)) from jsonb_array_elements_text(v_config) e)) x), '[]'::jsonb));
end;
$$;

revoke all on function public.product_group_head_options() from public, anon;
grant execute on function public.product_group_head_options() to authenticated;

-- -----------------------------------------------------------------------------
-- 4. BOM list with the product planning fields (security invoker: RLS applies)
-- Recreated on re-apply so the column list always matches.
-- -----------------------------------------------------------------------------
drop view if exists public.bom_list_v2;
create view public.bom_list_v2
with (security_invoker = true) as
select b.id, b.company_id, b.bom_code, b.finished_product_id, b.version, b.status, b.effective_from, b.effective_to,
  b.output_quantity, b.output_unit, b.notes, b.created_by, b.submitted_by, b.submitted_at, b.approved_by, b.approved_at,
  b.review_note, b.archived_by, b.archived_at, b.created_at, b.updated_at,
  p.sku, p.product_name, p.product_type, p.status as product_status,
  (select count(*) from public.bom_items bi where bi.bom_id = b.id) as item_count,
  p.gst_rate as tax_rate, p.lead_time_days, p.group_head, p.minimum_cover_days, p.ean
from public.boms b
join public.products p on p.id = b.finished_product_id;

revoke all on public.bom_list_v2 from anon, authenticated;
grant select on public.bom_list_v2 to authenticated;

notify pgrst, 'reload schema';
