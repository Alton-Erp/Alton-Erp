-- =============================================================================
-- Rollback of 20261129090000_opening_stock_master_cost.sql
-- Removes the cost functions and restores the two settings functions exactly as
-- 20261123090000 defined them. A stored inventory.opening_cost_override setting row is
-- removed (it is no longer a known setting). Posted opening stock is not touched.
-- =============================================================================
drop function if exists public.inventory_post_opening_stock_at_cost(jsonb, text, text, text, uuid);
drop function if exists public.inventory_submit_opening_stock_at_cost(jsonb, text, text, text, uuid);
drop function if exists public.opening_stock_product_costs(uuid[]);
drop function if exists private.opening_cost_audit(uuid, jsonb, jsonb);
drop function if exists private.opening_price_lines(uuid, jsonb);
drop function if exists private.opening_cost_override_allowed(uuid);
drop function if exists private.opening_master_costs(uuid, uuid[]);
delete from public.company_settings where setting_key = 'inventory.opening_cost_override';

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
    'product.purchase_cost_auto_update', true,
    'product.purchase_cost_increase_alerts', true,
    'product.purchase_cost_decrease_alerts', true,
    'product.purchase_cost_alert_percent', 10,
    'product.purchase_cost_zero_policy', 'IGNORE',
    'product.purchase_cost_override_permission', 'purchase_exception.approve',
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

create or replace function private.company_settings_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_t text := jsonb_typeof(new.setting_value);
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
       v_t = 'string' and (new.setting_value #>> '{}') in ('SKU', 'BARCODE', 'EAN', 'MODEL_NUMBER', 'PRODUCT_NAME', 'NONE')) then
    raise exception 'Import match key: SKU, Barcode, EAN, Model Number, Product Name or None.' using errcode = 'P0001';
  end if;
  if new.setting_key in ('product.purchase_cost_auto_update', 'product.purchase_cost_increase_alerts', 'product.purchase_cost_decrease_alerts')
     and v_t <> 'boolean' then
    raise exception 'This purchase cost option is on or off.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_alert_percent' and not (
       v_t = 'number' and (new.setting_value #>> '{}')::numeric between 0 and 1000
       and (new.setting_value #>> '{}')::numeric = round((new.setting_value #>> '{}')::numeric, 2)) then
    raise exception 'The significant change threshold is a percentage from 0 to 1000 (up to 2 decimals).' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_zero_policy' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('IGNORE', 'APPLY', 'INITIAL_ONLY')) then
    raise exception 'Zero-cost receipts: ignore, apply, or apply only when the product has no cost yet.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_override_permission' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('purchase_exception.approve', 'purchase_order.approve', 'products.update', 'settings.manage')) then
    raise exception 'Cost overrides: purchase exception approvers, purchase order approvers, product editors or settings managers.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.erp_setting_defaults() from public, anon, authenticated;
revoke all on function private.company_settings_validate() from public, anon, authenticated;
