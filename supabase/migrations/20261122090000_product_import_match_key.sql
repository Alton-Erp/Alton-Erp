-- =============================================================================
-- Product Excel import: configurable match key
--
-- Requested by the operator: ERP Settings -> Products chooses which field the
-- product import uses to find existing products, instead of always the SKU:
--   SKU (default) | BARCODE | EAN | MODEL_NUMBER | PRODUCT_NAME | NONE
-- NONE = no matching: the import only adds new products and never changes an
-- existing one (a SKU that already exists is still never created twice).
--
-- Changes (functions only; no table, no data changes):
--   * private.erp_setting_defaults(): new key product.import_match_key = 'SKU'
--     (same body as 20261114090000_bom_planning_product_ean.sql plus the key).
--   * private.company_settings_validate(): validates the new key on every write
--     path (same body as 20261114090000 plus the new check).
--   * public.product_import_match_key(): the configured key for users who may
--     read products (the import page); erp_settings_get needs settings.manage.
--
-- Rollback: supabase/rollback/20261122090000_product_import_match_key_down.sql
-- =============================================================================

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
    'product.import_match_key', 'SKU',
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
  if new.setting_key = 'product.import_match_key' and not (
       jsonb_typeof(new.setting_value) = 'string'
       and (new.setting_value #>> '{}') in ('SKU', 'BARCODE', 'EAN', 'MODEL_NUMBER', 'PRODUCT_NAME', 'NONE')) then
    raise exception 'Import match key: SKU, Barcode, EAN, Model Number, Product Name or None.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.company_settings_validate() from public, anon, authenticated;

-- The match key of the caller's company, for the product import page.
create or replace function public.product_import_match_key()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('products.read');
  v_key     text := coalesce(private.erp_setting(v_company, 'product.import_match_key') #>> '{}', 'SKU');
begin
  return case when v_key in ('SKU', 'BARCODE', 'EAN', 'MODEL_NUMBER', 'PRODUCT_NAME', 'NONE') then v_key else 'SKU' end;
end;
$$;

revoke all on function public.product_import_match_key() from public, anon;
grant execute on function public.product_import_match_key() to authenticated;
