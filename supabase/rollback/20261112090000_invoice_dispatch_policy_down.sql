-- Rollback of 20261112090000_invoice_dispatch_policy.sql
-- Removes the posting rule (triggers) and its read functions. Invoices, dispatches
-- and stock are not touched. products.inventory_tracked is kept by default (dropping a
-- column loses the operator's classification); uncomment the last statement to
-- remove it too.

begin;

drop trigger if exists sales_invoices_dispatch_guard on public.sales_invoices;
drop trigger if exists fulfilment_lines_dispatch_reversal_guard on public.fulfilment_lines;

drop function if exists public.invoice_dispatch_status(uuid);
drop function if exists public.invoice_dispatch_exceptions();
drop function if exists private.invoice_dispatch_guard();
drop function if exists private.dispatch_reversal_guard();
drop function if exists private.invoice_dispatch_lines(uuid);
drop function if exists private.so_line_dispatch_open(uuid, uuid, uuid, numeric);
drop function if exists private.fulfilment_line_dispatch_open(uuid, uuid, numeric);

-- alter table public.products drop column if exists inventory_tracked;

notify pgrst, 'reload schema';

commit;
