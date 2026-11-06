-- Rollback of 20261123090000_purchase_cost_intelligence.sql
--
-- Stops automatic Last Purchase Cost updates: removes the triggers on goods receipt lines and goods receipts,
-- the read / override functions and the purchase cost settings (settings defaults and validation of
-- 20261122090000_product_import_match_key.sql are restored). Goods receipt posting and reversal work exactly
-- as before the migration.
--
-- The two tables and their rows are KEPT by default (the history cannot be rebuilt: receipt dates, policies,
-- overrides and reversals at the time are not stored elsewhere). They stay in the ERP reset list, so a reset
-- still clears them. To remove them as well, uncomment the block at the end.
-- Saved purchase cost settings rows in company_settings are kept and ignored.

begin;

drop trigger if exists goods_receipt_lines_purchase_cost on public.goods_receipt_lines;
drop trigger if exists goods_receipts_purchase_cost_reversal on public.goods_receipts;
drop function if exists private.purchase_cost_on_receipt_line();
drop function if exists private.purchase_cost_on_receipt_reversal();
drop function if exists public.product_purchase_costs(uuid[], uuid);
drop function if exists public.product_purchase_cost_history(uuid);
drop function if exists public.product_purchase_cost_override(uuid, numeric, text);
drop function if exists private.purchase_cost_process_receipt(uuid);
drop function if exists private.purchase_cost_notify(public.product_purchase_cost_events);
drop function if exists private.purchase_cost_set_current(public.product_purchase_cost_events, public.product_purchase_cost_events);
drop function if exists private.purchase_cost_source(uuid, uuid, uuid);
drop function if exists private.purchase_cost_lock(uuid, uuid);
drop function if exists private.purchase_cost_settings(uuid);

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

-- Optional: remove the tables and their data as well. Then also re-create private.erp_reset_tables()
-- from 20261118090000_master_versioning.sql (without the two purchase cost tables).
-- drop table if exists public.product_last_purchase_costs;
-- drop table if exists public.product_purchase_cost_events;

notify pgrst, 'reload schema';

commit;
