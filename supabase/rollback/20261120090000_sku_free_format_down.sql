-- =============================================================================
-- Rollback of 20261120090000_sku_free_format.sql
--
-- Restores the original SKU format rule for new and changed products. The rule is added
-- NOT VALID, so products already saved with a free-format SKU (spaces, symbols, longer
-- than 50 characters) are kept as they are; nothing is deleted or renamed.
-- To find them:  select id, sku from public.products where sku !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$';
-- =============================================================================

alter table public.products drop constraint if exists products_sku_check;
alter table public.products add constraint products_sku_check check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$') not valid;
