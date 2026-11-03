-- Rollback of 20261114090000_bom_planning_product_ean.sql
-- Removes the BOM planning view, the group-head options RPC and settings
-- validation, and restores the settings defaults of 20261108090000.
-- The product columns (ean, group_head, minimum_cover_days) and their values are
-- KEPT by default, because dropping them loses data the operator entered. To remove
-- them as well, uncomment the block at the end.

begin;

drop view if exists public.bom_list_v2;
drop function if exists public.product_group_head_options();
drop trigger if exists company_settings_validate on public.company_settings;
drop function if exists private.company_settings_validate();

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

-- Optional: remove the columns and their data as well.
-- drop index if exists public.products_company_ean_unique;
-- drop index if exists public.products_company_group_head_idx;
-- alter table public.products drop constraint if exists products_ean_format;
-- alter table public.products drop constraint if exists products_group_head_length;
-- alter table public.products drop constraint if exists products_minimum_cover_days_range;
-- alter table public.products drop column if exists ean;
-- alter table public.products drop column if exists group_head;
-- alter table public.products drop column if exists minimum_cover_days;
-- drop function if exists private.ean_valid(text);

notify pgrst, 'reload schema';

commit;
