-- =============================================================================
-- Phase 11: supporting indexes for foreign keys on common query paths.
--
-- Additive only (CREATE INDEX IF NOT EXISTS): no data is changed and re-running
-- is safe. On a large production table, consider creating the same index with
-- CREATE INDEX CONCURRENTLY from the SQL Editor first (it cannot run inside a
-- migration transaction); this file then finds it already present.
-- =============================================================================

-- Customer history (statements, PO lists, returns, notes per customer)
create index if not exists customer_purchase_orders_customer_idx on public.customer_purchase_orders (company_id, customer_id);
create index if not exists customer_returns_customer_idx on public.customer_returns (company_id, customer_id);
create index if not exists invoice_adjustment_notes_customer_idx on public.invoice_adjustment_notes (company_id, customer_id);

-- Product-level lookups (product history, BOM usage, invoice lines per product)
create index if not exists sales_invoice_lines_product_idx on public.sales_invoice_lines (product_id);
create index if not exists sales_invoice_lines_so_line_idx on public.sales_invoice_lines (sales_order_line_id);
create index if not exists production_order_materials_component_idx on public.production_order_materials (component_product_id);
create index if not exists outsourcing_order_materials_component_idx on public.outsourcing_order_materials (component_product_id);
create index if not exists outsourcing_orders_product_idx on public.outsourcing_orders (product_id);
create index if not exists inventory_adjustments_product_idx on public.inventory_adjustments (product_id);
create index if not exists inventory_count_lines_product_idx on public.inventory_count_lines (product_id);
create index if not exists customer_product_codes_product_idx on public.customer_product_codes (product_id);

-- Location-level lookups (stock by location, reservations by location, location history)
create index if not exists inventory_balances_location_idx on public.inventory_balances (location_id);
create index if not exists stock_reservations_location_idx on public.stock_reservations (location_id);
create index if not exists inventory_transactions_location_idx on public.inventory_transactions (location_id, transaction_date);

-- Workflow and document links
create index if not exists production_orders_bom_idx on public.production_orders (bom_id);
create index if not exists customer_return_lines_so_line_idx on public.customer_return_lines (sales_order_line_id);
create index if not exists fulfilment_lines_issue_tx_idx on public.fulfilment_lines (issue_transaction_id) where issue_transaction_id is not null;
create index if not exists approval_requests_workflow_idx on public.approval_requests (workflow_id);
