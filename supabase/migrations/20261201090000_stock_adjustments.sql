-- =============================================================================
-- Stock Adjustments (restored in V2): configured reasons and attachments
--
-- Inspected first: the adjustment workflow already exists and is reused unchanged:
--   inventory_adjustments (system quantity before, counted quantity after, generated
--   difference, requested_by / reviewed_by / timestamps, review_note = rejection reason),
--   inventory_create_adjustment (draft or submit; idempotent), inventory_update_adjustment_status
--   (submit / cancel by the requester), inventory_review_adjustment (approve -> ADJUSTMENT_IN /
--   ADJUSTMENT_OUT through private.post_movement, the existing ledger posting; reject with a
--   reason; segregation of duties through private.assert_not_self_approval, i.e. the company
--   switch inventory.segregation_of_duties; idempotent; a posted adjustment cannot be reviewed
--   again), inventory_post_adjustment (one-step for a single operator) and the audit log.
--
-- Missing, added here:
--   1. inventory_adjustments.reason_label: the reason chosen from ERP Settings -> Inventory ->
--      Stock adjustment reasons (inventory.adjustment_reasons). The fixed reason_code category
--      stays as before. Nullable: existing adjustments are unchanged.
--   2. inventory_create_adjustment_v2 / inventory_post_adjustment_v2: the same as the existing
--      functions (which they call) plus the configured reason, checked against the company's
--      list on the server.
--   3. Attachments: documents can be linked to a stock adjustment (STOCK_ADJUSTMENT). The four
--      document functions are copied from 20261104090000 with that one type added.
--
-- Not changed: opening stock, GRN, purchase orders, production, outsourcing, fulfilment,
-- inventory balances, ledger entries, the existing adjustment functions and their permissions.
-- Rollback: supabase/rollback/20261201090000_stock_adjustments_down.sql
-- =============================================================================

-- 1. The configured reason
alter table public.inventory_adjustments add column if not exists reason_label text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_adjustments_reason_label_check') then
    alter table public.inventory_adjustments add constraint inventory_adjustments_reason_label_check
      check (reason_label is null or length(btrim(reason_label)) between 1 and 100);
  end if;
end $$;
comment on column public.inventory_adjustments.reason_label is
  'Reason chosen from ERP Settings (inventory.adjustment_reasons) when the adjustment was recorded (20261201090000).';
create index if not exists inventory_adjustments_reason_idx on public.inventory_adjustments (company_id, reason_label) where reason_label is not null;

-- The configured reason of a company that matches p_label (ignoring case and spaces), or null.
create or replace function private.adjustment_reason_label(p_company uuid, p_label text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r from jsonb_array_elements_text(coalesce(private.erp_setting(p_company, 'inventory.adjustment_reasons'), '[]'::jsonb)) r
  where lower(btrim(r)) = lower(btrim(coalesce(p_label, ''))) limit 1;
$$;
revoke all on function private.adjustment_reason_label(uuid, text) from public, anon, authenticated;

-- Record an adjustment (draft or submitted) with its configured reason.
create or replace function public.inventory_create_adjustment_v2(
  p_reason_label        text,
  p_adjustment_type     text,
  p_product_id          uuid,
  p_location_id         uuid,
  p_reason_code         text,
  p_batch_id            uuid default null,
  p_batch_number        text default null,
  p_source_type         text default null,
  p_counted_quantity    numeric default null,
  p_correction_quantity numeric default null,
  p_target_source_type  text default null,
  p_unit_cost           numeric default null,
  p_notes               text default null,
  p_reference           text default null,
  p_effective_date      date default null,
  p_submit              boolean default true,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.adjust');
  v_label   text := private.adjustment_reason_label(v_company, p_reason_label);
  v_result  jsonb;
begin
  if p_adjustment_type = 'QUANTITY' and v_label is null then
    raise exception 'Select a stock adjustment reason from the list in ERP Settings.' using errcode = 'P0001';
  end if;
  if p_adjustment_type <> 'QUANTITY' and nullif(btrim(coalesce(p_reason_label, '')), '') is not null and v_label is null then
    raise exception 'Select a stock adjustment reason from the list in ERP Settings.' using errcode = 'P0001';
  end if;
  v_result := public.inventory_create_adjustment(p_adjustment_type, p_product_id, p_location_id, p_reason_code, p_batch_id, p_batch_number,
    p_source_type, p_counted_quantity, p_correction_quantity, p_target_source_type, p_unit_cost, p_notes, p_reference, p_effective_date,
    p_submit, p_idempotency_key);
  -- A repeated request returns the stored result; the label is written once.
  update public.inventory_adjustments set reason_label = v_label
  where id = (v_result ->> 'adjustment_id')::uuid and company_id = v_company and reason_label is null and v_label is not null;
  return v_result || jsonb_build_object('reason_label', v_label);
end;
$$;

-- Record and post in one step (single operator; the review function still applies segregation of duties).
create or replace function public.inventory_post_adjustment_v2(
  p_reason_label        text,
  p_adjustment_type     text,
  p_product_id          uuid,
  p_location_id         uuid,
  p_reason_code         text,
  p_batch_id            uuid default null,
  p_batch_number        text default null,
  p_source_type         text default null,
  p_counted_quantity    numeric default null,
  p_correction_quantity numeric default null,
  p_target_source_type  text default null,
  p_unit_cost           numeric default null,
  p_notes               text default null,
  p_reference           text default null,
  p_effective_date      date default null,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.adjust');
  v_created jsonb;
  v_id      uuid;
  v_status  text;
  v_posted  jsonb;
begin
  v_created := public.inventory_create_adjustment_v2(p_reason_label, p_adjustment_type, p_product_id, p_location_id, p_reason_code,
    p_batch_id, p_batch_number, p_source_type, p_counted_quantity, p_correction_quantity, p_target_source_type,
    p_unit_cost, p_notes, p_reference, p_effective_date, true, p_idempotency_key);
  v_id := (v_created ->> 'adjustment_id')::uuid;
  select status into v_status from public.inventory_adjustments where id = v_id and company_id = v_company;
  if v_status = 'PENDING_APPROVAL' then
    v_posted := public.inventory_review_adjustment(v_id, 'APPROVE', p_notes, gen_random_uuid());
  end if;
  select status into v_status from public.inventory_adjustments where id = v_id and company_id = v_company;
  return v_created || coalesce(v_posted, '{}'::jsonb) || jsonb_build_object('adjustment_id', v_id, 'status', v_status);
end;
$$;

revoke all on function public.inventory_create_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, boolean, uuid),
  public.inventory_post_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, uuid) from public, anon;
grant execute on function public.inventory_create_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, boolean, uuid),
  public.inventory_post_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, uuid) to authenticated;

-- 2. Attachments on stock adjustments
do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.documents'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%related_entity_type%'
  loop
    execute format('alter table public.documents drop constraint %I', v_name);
  end loop;
end;
$$;
alter table public.documents add constraint documents_related_entity_type_check check (related_entity_type in ('PRODUCT', 'BATCH', 'WAREHOUSE',
  'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER', 'COMPANY',
  'SUPPLIER_PO', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT'));

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
    union all select a.adjustment_number, 'inventory.read', '/inventory/adjustments?adj=' || a.id from public.inventory_adjustments a where p_type = 'STOCK_ADJUSTMENT' and a.id = p_id and a.company_id = p_company
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
    when 'SUPPLIER_PO' then 'purchases.read' when 'GOODS_RECEIPT' then 'purchases.read'
    when 'STOCK_ADJUSTMENT' then 'inventory.read' end;
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
    union all select a.id, a.adjustment_number from public.inventory_adjustments a where p_entity_type = 'STOCK_ADJUSTMENT' and a.company_id = v_company and a.adjustment_number ilike v_t
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
    'SUPPLIER_PO', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT'];
$$;
