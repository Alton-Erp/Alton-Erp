-- Rollback of 20261209090000_gst_exclusive_reporting.sql: drops only the read-only functions and
-- views that migration created. No table, posted document or existing function is touched.
drop function if exists public.gst_exclusive_dashboard(text, date, date, uuid, text, text);
drop function if exists public.sales_orders_v2_list_excl_gst(date, date, uuid, text);
drop function if exists public.ledger_parties_excl_gst(text, text, text, uuid);
drop function if exists private.po_pending_taxable(uuid);
drop view if exists public.purchase_order_list_excl_gst;
drop function if exists private.party_balances_excl_gst(uuid);
drop function if exists private.invoice_excl_gst(uuid);
drop view if exists public.sales_invoice_list_excl_gst;
drop function if exists private.goods_receipt_taxable_value(uuid);
