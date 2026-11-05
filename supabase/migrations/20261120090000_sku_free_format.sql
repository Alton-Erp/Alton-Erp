-- =============================================================================
-- Free-format SKUs
--
-- Requested by the operator: remove the SKU format rule
--   "1–50 letters, digits or . _ / - (no spaces), starting with a letter or digit"
-- (check products_sku_check from 20261011090000_product_master.sql).
--
-- Kept: a SKU is required (a blank SKU still gets the next automatic code), it has no
-- leading or trailing spaces (so "ABC" and "ABC " cannot both exist), it is unique per
-- company regardless of case (products_company_sku_unique), and it cannot change once
-- transactions reference the product (before_product_write).
-- No data changes: every existing SKU already satisfies the new rule.
--
-- Rollback: supabase/rollback/20261120090000_sku_free_format_down.sql
-- =============================================================================

alter table public.products drop constraint if exists products_sku_check;
alter table public.products add constraint products_sku_check check (sku <> '' and sku = btrim(sku));
