-- ROLLBACK of 20261110090000_readonly_rpc_fix.sql: restores the previous
-- volatility (STABLE). Note: with STABLE, PostgREST runs these functions
-- read-only and they fail again ("cannot execute INSERT in a read-only transaction").
alter function public.erp_settings_get() stable;
alter function public.invoice_import_preview(jsonb) stable;
alter function private.invoice_import_check(uuid, jsonb) stable;
notify pgrst, 'reload schema';
