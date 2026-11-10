-- =============================================================================
-- Rollback of 20261201090000_stock_adjustments.sql
--
-- Stops if a document is attached to a stock adjustment (documents are archived, never
-- deleted, so that type must stay). Otherwise restores the four document functions and the
-- entity check exactly as 20261104090000 defined them, removes the two functions and drops
-- the reason_label column (the configured reason texts of adjustments are lost; the
-- adjustments, their reason category, ledger entries and balances are not touched).
-- =============================================================================
do $$
begin
  if exists (select 1 from public.documents where related_entity_type = 'STOCK_ADJUSTMENT') then
    raise exception 'Documents are attached to stock adjustments; this rollback would orphan them. Archive is not enough: keep 20261201090000.';
  end if;
end $$;

drop function if exists public.inventory_post_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, uuid);
drop function if exists public.inventory_create_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, boolean, uuid);
drop function if exists private.adjustment_reason_label(uuid, text);
drop index if exists public.inventory_adjustments_reason_idx;
alter table public.inventory_adjustments drop constraint if exists inventory_adjustments_reason_label_check;
alter table public.inventory_adjustments drop column if exists reason_label;

alter table public.documents drop constraint if exists documents_related_entity_type_check;
alter table public.documents add constraint documents_related_entity_type_check check (related_entity_type in ('PRODUCT', 'BATCH', 'WAREHOUSE',
  'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER', 'COMPANY',
  'SUPPLIER_PO', 'GOODS_RECEIPT'));

create or replace function private.document_entity(p_company uuid, p_type text, p_id uuid)
returns table (reference text, read_permission text, link text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select x.reference, x.perm, x.link from (
    select p.sku as reference, 'products.read' as perm, '/products/' || p.id as link from public.products p where p_type = 'PRODUCT' and p.id = p_id and p.company_id = p_company
    union all select coalesce(b.batch_number, 'Untracked lot') || ' · ' || p.sku, 'inventory.read', '/inventory/stock/' || p.id
      from public.inventory_batches b join public.products p on p.id = b.product_id where p_type = 'BATCH' and b.id = p_id and b.company_id = p_company
    union all select w.warehouse_code, 'inventory.read', '/inventory/warehouses' from public.warehouses w where p_type = 'WAREHOUSE' and w.id = p_id and w.company_id = p_company
    union all select o.production_order_number, 'manufacturing.read', '/production/orders/' || o.id from public.production_orders o where p_type = 'PRODUCTION_ORDER' and o.id = p_id and o.company_id = p_company
    union all select o.outsourcing_order_number, 'outsourcing.read', '/production/outsourcing/' || o.id from public.outsourcing_orders o where p_type = 'OUTSOURCING_ORDER' and o.id = p_id and o.company_id = p_company
    union all select o.customer_po_number || ' (' || o.po_reference || ')', 'customer_po.read', '/customer-pos/' || o.id from public.customer_purchase_orders o where p_type = 'CUSTOMER_PO' and o.id = p_id and o.company_id = p_company
    union all select s.sales_order_number, 'sales_orders.read', '/sales/order-details?so=' || s.id from public.sales_orders s where p_type = 'SALES_ORDER' and s.id = p_id and s.company_id = p_company
    union all select f.fulfilment_number, 'fulfilment.read', '/sales/delivery?f=' || f.id from public.fulfilments f where p_type = 'DISPATCH' and f.id = p_id and f.company_id = p_company
    union all select coalesce(i.invoice_number, 'Draft invoice'), 'invoices.read', '/billing/invoices/' || i.id from public.sales_invoices i where p_type = 'INVOICE' and i.id = p_id and i.company_id = p_company
    union all select coalesce(n.note_number, 'Draft note'), 'invoices.read', '/billing/notes/' || n.id from public.invoice_adjustment_notes n where p_type = 'ADJUSTMENT_NOTE' and n.id = p_id and n.company_id = p_company
    union all select c.customer_code || ' — ' || c.customer_name, 'customers.read', '/customers' from public.customers c where p_type = 'CUSTOMER' and c.id = p_id and c.company_id = p_company
    union all select c.legal_name, 'settings.manage', '/settings' from public.companies c where p_type = 'COMPANY' and c.id = p_id and c.id = p_company
    union all select o.po_number, 'purchases.read', '/purchase-orders/' || o.id from public.purchase_orders o where p_type = 'SUPPLIER_PO' and o.id = p_id and o.company_id = p_company
    union all select g.receipt_number, 'purchases.read', '/goods-receipts/' || g.id from public.goods_receipts g where p_type = 'GOODS_RECEIPT' and g.id = p_id and g.company_id = p_company
  ) x;
end;
$$;

create or replace function private.document_entity_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCT' then 'products.read' when 'BATCH' then 'inventory.read' when 'WAREHOUSE' then 'inventory.read'
    when 'PRODUCTION_ORDER' then 'manufacturing.read' when 'OUTSOURCING_ORDER' then 'outsourcing.read' when 'CUSTOMER_PO' then 'customer_po.read'
    when 'SALES_ORDER' then 'sales_orders.read' when 'DISPATCH' then 'fulfilment.read' when 'INVOICE' then 'invoices.read'
    when 'ADJUSTMENT_NOTE' then 'invoices.read' when 'CUSTOMER' then 'customers.read' when 'COMPANY' then 'settings.manage'
    when 'SUPPLIER_PO' then 'purchases.read' when 'GOODS_RECEIPT' then 'purchases.read' end;
$$;

create or replace function public.document_entity_search(p_entity_type text, p_term text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('documents.read');
  v_t       text := '%' || replace(replace(btrim(coalesce(p_term, '')), '%', ''), '_', '') || '%';
begin
  if private.document_entity_permission(p_entity_type) is null or not private.has_permission(v_company, private.document_entity_permission(p_entity_type)) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'reference', reference)) from (
    select p.id, p.sku || ' — ' || p.product_name as reference from public.products p where p_entity_type = 'PRODUCT' and p.company_id = v_company and (p.sku ilike v_t or p.product_name ilike v_t)
    union all select b.id, coalesce(b.batch_number, 'Untracked lot') || ' · ' || p.sku from public.inventory_batches b join public.products p on p.id = b.product_id
      where p_entity_type = 'BATCH' and b.company_id = v_company and (b.batch_number ilike v_t or p.sku ilike v_t)
    union all select w.id, w.warehouse_code || ' — ' || w.warehouse_name from public.warehouses w where p_entity_type = 'WAREHOUSE' and w.company_id = v_company and (w.warehouse_code ilike v_t or w.warehouse_name ilike v_t)
    union all select o.id, o.production_order_number from public.production_orders o where p_entity_type = 'PRODUCTION_ORDER' and o.company_id = v_company and o.production_order_number ilike v_t
    union all select o.id, o.outsourcing_order_number || ' · ' || o.supplier_name from public.outsourcing_orders o where p_entity_type = 'OUTSOURCING_ORDER' and o.company_id = v_company and (o.outsourcing_order_number ilike v_t or o.supplier_name ilike v_t)
    union all select o.id, o.customer_po_number || ' (' || o.po_reference || ')' from public.customer_purchase_orders o where p_entity_type = 'CUSTOMER_PO' and o.company_id = v_company and o.is_current and (o.customer_po_number ilike v_t or o.po_reference ilike v_t)
    union all select s.id, s.sales_order_number || ' · ' || s.customer_name_snapshot from public.sales_orders s where p_entity_type = 'SALES_ORDER' and s.company_id = v_company and (s.sales_order_number ilike v_t or s.customer_name_snapshot ilike v_t)
    union all select f.id, f.fulfilment_number from public.fulfilments f where p_entity_type = 'DISPATCH' and f.company_id = v_company and f.fulfilment_number ilike v_t
    union all select i.id, coalesce(i.invoice_number, 'Draft') || ' · ' || i.customer_legal_name from public.sales_invoices i where p_entity_type = 'INVOICE' and i.company_id = v_company and i.status <> 'DISCARDED' and (i.invoice_number ilike v_t or i.customer_legal_name ilike v_t)
    union all select n.id, coalesce(n.note_number, 'Draft note') from public.invoice_adjustment_notes n where p_entity_type = 'ADJUSTMENT_NOTE' and n.company_id = v_company and n.status <> 'DISCARDED' and coalesce(n.note_number, '') ilike v_t
    union all select c.id, c.customer_code || ' — ' || c.customer_name from public.customers c where p_entity_type = 'CUSTOMER' and c.company_id = v_company and (c.customer_code ilike v_t or c.customer_name ilike v_t)
    union all select c.id, c.legal_name from public.companies c where p_entity_type = 'COMPANY' and c.id = v_company
    union all select o.id, o.po_number || ' · ' || o.supplier_name from public.purchase_orders o where p_entity_type = 'SUPPLIER_PO' and o.company_id = v_company and (o.po_number ilike v_t or o.supplier_name ilike v_t)
    union all select g.id, g.receipt_number from public.goods_receipts g where p_entity_type = 'GOODS_RECEIPT' and g.company_id = v_company and g.receipt_number ilike v_t
    limit 20) x), '[]'::jsonb);
end;
$$;

create or replace function private.erp_reset_document_entity_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['BATCH', 'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER',
    'SUPPLIER_PO', 'GOODS_RECEIPT'];
$$;
