-- =============================================================================
-- ALTON ERP V2 — Fix: ERP Settings tabs and the invoice import preview fail on
-- the hosted API with "cannot execute INSERT in a read-only transaction".
--
-- PostgREST runs RPCs declared STABLE or IMMUTABLE inside a READ ONLY
-- transaction. These functions were declared STABLE but call
-- private.billing_settings(), which always runs
--   insert into public.invoice_settings (company_id) ... on conflict do nothing
-- (it creates the company's default invoice settings on first use). The
-- read-only check rejects that INSERT even when the row already exists, so the
-- call failed every time through the API. The local SQL suites call the
-- functions in read-write transactions, which is why they passed.
--
--   public.erp_settings_get()            ERP Settings: Company, Products,
--                                        Inventory, Purchase, Production,
--                                        Sales and Excel import tabs
--   public.invoice_import_preview(jsonb) Billing > Invoice import preview
--   private.invoice_import_check(uuid, jsonb)  (its helper)
--
-- Fix: declare them VOLATILE, the same as billing_settings_get() which uses
-- the same helper and works. Bodies, permissions, grants, RLS and data are
-- unchanged. Rollback: supabase/rollback/20261110090000_readonly_rpc_fix_down.sql
-- =============================================================================

alter function public.erp_settings_get() volatile;
alter function public.invoice_import_preview(jsonb) volatile;
alter function private.invoice_import_check(uuid, jsonb) volatile;

-- PostgREST caches function volatility: reload its schema cache.
notify pgrst, 'reload schema';
