-- Rollback of 20261208090000_product_cost_intelligence.sql
--
-- Removes the stored BOM costs, product cost sources and product cost history (their rows are lost),
-- the cost triggers and RPCs, and restores product_master_list (20261128090000) and
-- private.erp_reset_tables (20261203090000) exactly. Products, BOMs, GRNs, purchase cost history,
-- stock and posted transactions are not touched: no stored value of theirs was ever changed.

drop trigger if exists boms_product_cost on public.boms;
drop trigger if exists product_cost_follows_last_purchase on public.product_last_purchase_costs;
drop trigger if exists products_product_cost on public.products;

drop function if exists public.product_cost_recalculate(uuid[]);
drop function if exists public.product_cost_set_default_source(uuid, text, text);
drop function if exists public.product_sourcing_proposals(uuid[], boolean);
drop function if exists public.product_sourcing_apply(uuid, text, text);
drop function if exists private.product_cost_on_bom_status();
drop function if exists private.product_cost_on_purchase_cost();
drop function if exists private.product_cost_on_product();
drop function if exists private.product_cost_refresh(uuid, uuid, text, text, integer);
drop function if exists private.bom_cost_store(uuid, text);

drop view if exists public.bom_cost_list;
drop function if exists private.product_master_cost(uuid);
drop view if exists public.product_master_list;
create view public.product_master_list
with (security_invoker = true) as
select p.*,
  coalesce(r.cost, f.standard) as master_cost,
  case when r.cost is not null then 'PURCHASE' when f.standard is not null then 'STANDARD' end as master_cost_source,
  r.receipt_number as master_cost_receipt_number,
  r.receipt_date as master_cost_receipt_date,
  f.standard as fallback_cost,
  c.last_purchase_cost,
  c.last_purchase_date,
  c.last_purchase_cost - coalesce(r.cost, f.standard) as master_cost_change,
  case when coalesce(r.cost, f.standard) > 0 and c.last_purchase_cost is not null
       then round((c.last_purchase_cost - coalesce(r.cost, f.standard)) / coalesce(r.cost, f.standard) * 100, 2) end as master_cost_change_percent
from public.products p
cross join lateral (select coalesce(p.standard_manufacturing_cost, p.standard_cost) as standard) f
left join public.product_last_purchase_costs c on c.company_id = p.company_id and c.product_id = p.id
left join lateral (
  select e.new_cost as cost, e.receipt_number, e.effective_date as receipt_date
  from public.product_purchase_cost_events e
  where e.company_id = p.company_id and e.product_id = p.id
    and e.event_type = 'GRN_RECEIPT' and e.eligible and e.new_cost is not null
    and not exists (select 1 from public.product_purchase_cost_events x where x.reversal_of_event_id = e.id)
  order by e.effective_date desc, e.posted_at desc, e.created_at desc
  offset 1 limit 1
) r on true;

comment on view public.product_master_list is
  'Product Master rows with Cost = second-most-recent valid purchase receipt (else the standard cost), Last Purchase Cost / Date and Cost Change (migration 20261128090000).';

revoke all on public.product_master_list from public, anon;
grant select on public.product_master_list to authenticated;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'bom_template_items', 'Production & BOMs', 'BOM template components'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'erp_form_drafts', 'Approvals, notifications & imports', 'Unsaved form drafts'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'product_last_purchase_costs', 'Supplier purchasing', 'Last purchase costs'),
    (0, 'product_purchase_cost_events', 'Supplier purchasing', 'Purchase cost history'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_order_requests', 'Production & BOMs', 'Production order request ids'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'bom_templates', 'Production & BOMs', 'BOM templates'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'production_order_revisions', 'Production & BOMs', 'Production order revisions'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;
revoke all on function private.erp_reset_tables() from public, anon, authenticated;

drop table if exists public.product_cost_history;
drop table if exists public.product_cost_profiles;
drop table if exists public.bom_cost_snapshots;

notify pgrst, 'reload schema';
