-- Rollback of 20261121090000_product_bulk_delete.sql
--
-- Removes the bulk delete functions only. No table, row, policy or trigger was changed by the
-- migration, so nothing else is restored. Products already deleted stay deleted (their audit
-- rows stay in audit_logs).

drop function if exists public.product_bulk_delete(uuid[], text, text, boolean, uuid);
drop function if exists public.product_bulk_delete_preview(uuid[]);
drop function if exists public.product_duplicate_hints(uuid[]);
drop function if exists private.product_bulk_delete_check(uuid, uuid[]);
drop function if exists private.product_bulk_delete_company();
drop function if exists private.product_references(uuid[]);
drop function if exists private.product_reference_sources();
