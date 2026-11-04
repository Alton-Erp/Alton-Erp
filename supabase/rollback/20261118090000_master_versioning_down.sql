-- Rollback of 20261118090000_master_versioning.sql
-- Restores the previous report functions, list views, BOM item guard and ERP reset
-- lists, then removes the version tables, snapshot columns and triggers.
-- Posted transactions, orders, BOMs and products are not changed (the snapshot
-- columns are dropped; their values are lost, which only affects reporting).
-- Order: roll this back before 20261117 / 20261116 / 20261113 / 20261111 (newest first).

begin;

-- 1. Previous definitions (they do not use the new columns or functions).
drop view if exists public.inventory_transaction_list;
create view public.inventory_transaction_list
with (security_invoker = true) as
SELECT t.id,
    t.company_id,
    t.transaction_number,
    t.transaction_type,
    t.direction,
    t.product_id,
    t.batch_id,
    t.warehouse_id,
    t.location_id,
    t.quantity,
    t.unit,
    t.source_type,
    t.unit_cost,
    t.reference_type,
    t.reference_number,
    t.reference_id,
    t.reason,
    t.notes,
    t.transaction_date,
    t.status,
    t.document_type,
    t.document_id,
    t.transfer_group_id,
    t.reversal_of_transaction_id,
    t.created_by,
    t.approved_by,
    t.created_at,
    p.sku,
    p.product_name,
    bt.batch_number,
    w.warehouse_code,
    w.warehouse_name,
    l.location_code,
    l.location_name,
        CASE
            WHEN (t.direction = 1) THEN t.quantity
            ELSE NULL::numeric
        END AS quantity_in,
        CASE
            WHEN (t.direction = '-1'::integer) THEN t.quantity
            ELSE NULL::numeric
        END AS quantity_out,
    pair.location_id AS counterpart_location_id,
    pl.location_code AS counterpart_location_code,
    pw.warehouse_code AS counterpart_warehouse_code,
    r.id AS reversed_by_transaction_id,
    r.transaction_number AS reversed_by_number,
    orig.transaction_number AS reversal_of_number
   FROM (((((((((inventory_transactions t
     JOIN products p ON ((p.id = t.product_id)))
     JOIN inventory_batches bt ON ((bt.id = t.batch_id)))
     JOIN warehouses w ON ((w.id = t.warehouse_id)))
     JOIN inventory_locations l ON ((l.id = t.location_id)))
     LEFT JOIN inventory_transactions pair ON (((t.transaction_type = ANY (ARRAY['TRANSFER_OUT'::text, 'TRANSFER_IN'::text])) AND (pair.transfer_group_id = t.transfer_group_id) AND (pair.id <> t.id) AND (pair.transaction_type = ANY (ARRAY['TRANSFER_OUT'::text, 'TRANSFER_IN'::text])))))
     LEFT JOIN inventory_locations pl ON ((pl.id = pair.location_id)))
     LEFT JOIN warehouses pw ON ((pw.id = pair.warehouse_id)))
     LEFT JOIN inventory_transactions r ON ((r.reversal_of_transaction_id = t.id)))
     LEFT JOIN inventory_transactions orig ON ((orig.id = t.reversal_of_transaction_id)));
revoke all on public.inventory_transaction_list from anon, authenticated;
grant select on public.inventory_transaction_list to authenticated;

drop view if exists public.production_consumption_list;
create view public.production_consumption_list
with (security_invoker = true) as
SELECT c.id,
    c.company_id,
    c.production_order_id,
    c.order_material_id,
    c.component_product_id,
    c.batch_id,
    c.warehouse_id,
    c.location_id,
    c.planned_quantity,
    c.actual_quantity,
    c.unit,
    c.reserved_quantity_used,
    c.inventory_transaction_id,
    c.consumption_date,
    c.over_issue_reason,
    c.notes,
    c.status,
    c.reversal_transaction_ids,
    c.reversal_reason,
    c.reversed_by,
    c.reversed_at,
    c.recorded_by,
    c.created_at,
    o.production_order_number,
    o.status AS order_status,
    p.sku,
    p.product_name,
    bt.batch_number,
    bt.source_type,
    w.warehouse_code,
    l.location_code,
    t.transaction_number
   FROM ((((((production_material_consumption c
     JOIN production_orders o ON ((o.id = c.production_order_id)))
     JOIN products p ON ((p.id = c.component_product_id)))
     LEFT JOIN inventory_batches bt ON ((bt.id = c.batch_id)))
     LEFT JOIN warehouses w ON ((w.id = c.warehouse_id)))
     LEFT JOIN inventory_locations l ON ((l.id = c.location_id)))
     LEFT JOIN inventory_transactions t ON ((t.id = c.inventory_transaction_id)));
revoke all on public.production_consumption_list from anon, authenticated;
grant select on public.production_consumption_list to authenticated;

drop view if exists public.production_output_list;
create view public.production_output_list
with (security_invoker = true) as
SELECT r.id,
    r.company_id,
    r.receipt_number,
    r.production_order_id,
    r.product_id,
    r.batch_id,
    r.good_quantity,
    r.rejected_quantity,
    r.scrap_quantity,
    r.unit,
    r.good_location_id,
    r.rejected_location_id,
    r.good_transaction_id,
    r.rejected_transaction_id,
    r.production_date,
    r.unit_cost,
    r.quality_status,
    r.rejection_reason,
    r.over_production_reason,
    r.notes,
    r.status,
    r.reversal_transaction_ids,
    r.reversal_reason,
    r.reversed_by,
    r.reversed_at,
    r.created_by,
    r.created_at,
    o.production_order_number,
    o.status AS order_status,
    o.planned_quantity AS order_planned_quantity,
    p.sku,
    p.product_name,
    bt.batch_number,
    gl.location_code AS good_location_code,
    gw.warehouse_code AS good_warehouse_code,
    rl.location_code AS rejected_location_code,
    gt.transaction_number AS good_transaction_number,
    rt.transaction_number AS rejected_transaction_number
   FROM ((((((((production_output_receipts r
     JOIN production_orders o ON ((o.id = r.production_order_id)))
     JOIN products p ON ((p.id = r.product_id)))
     LEFT JOIN inventory_batches bt ON ((bt.id = r.batch_id)))
     LEFT JOIN inventory_locations gl ON ((gl.id = r.good_location_id)))
     LEFT JOIN warehouses gw ON ((gw.id = gl.warehouse_id)))
     LEFT JOIN inventory_locations rl ON ((rl.id = r.rejected_location_id)))
     LEFT JOIN inventory_transactions gt ON ((gt.id = r.good_transaction_id)))
     LEFT JOIN inventory_transactions rt ON ((rt.id = r.rejected_transaction_id)));
revoke all on public.production_output_list from anon, authenticated;
grant select on public.production_output_list to authenticated;

drop view if exists public.production_order_list;
create view public.production_order_list
with (security_invoker = true) as
SELECT o.id,
    o.company_id,
    o.production_order_number,
    o.finished_product_id,
    o.bom_id,
    o.bom_code,
    o.bom_version,
    o.unit,
    o.planned_quantity,
    o.completed_quantity,
    o.rejected_quantity,
    o.scrap_quantity,
    o.actual_quantity,
    o.status,
    o.status_before_hold,
    o.priority,
    o.source_warehouse_id,
    o.destination_warehouse_id,
    o.planned_start_date,
    o.target_completion_date,
    o.actual_start_date,
    o.actual_completion_date,
    o.notes,
    o.review_note,
    o.hold_reason,
    o.cancel_reason,
    o.completion_note,
    o.created_by,
    o.submitted_by,
    o.submitted_at,
    o.approved_by,
    o.approved_at,
    o.started_by,
    o.completed_by,
    o.completed_at,
    o.cancelled_by,
    o.cancelled_at,
    o.created_at,
    o.updated_at,
    o.sales_order_id,
    o.sales_order_line_id,
    p.sku,
    p.product_name,
    sw.warehouse_code AS source_warehouse_code,
    dw.warehouse_code AS destination_warehouse_code,
    COALESCE(m.lines, (0)::bigint) AS material_lines,
    COALESCE(m.lines_issued, (0)::bigint) AS material_lines_issued,
        CASE
            WHEN (COALESCE(m.issued_any, false) = false) THEN 'NOT_ISSUED'::text
            WHEN (m.lines_issued = m.lines) THEN 'FULLY_ISSUED'::text
            ELSE 'PARTIALLY_ISSUED'::text
        END AS material_status,
    ((o.status <> ALL (ARRAY['COMPLETED'::text, 'CANCELLED'::text])) AND (o.target_completion_date < ((now() AT TIME ZONE COALESCE(c.timezone, 'UTC'::text)))::date)) AS is_overdue
   FROM (((((production_orders o
     JOIN products p ON ((p.id = o.finished_product_id)))
     JOIN companies c ON ((c.id = o.company_id)))
     LEFT JOIN warehouses sw ON ((sw.id = o.source_warehouse_id)))
     LEFT JOIN warehouses dw ON ((dw.id = o.destination_warehouse_id)))
     LEFT JOIN ( SELECT production_order_materials.production_order_id,
            count(*) AS lines,
            count(*) FILTER (WHERE (production_order_materials.issued_quantity >= production_order_materials.planned_quantity)) AS lines_issued,
            bool_or((production_order_materials.issued_quantity > (0)::numeric)) AS issued_any
           FROM production_order_materials
          GROUP BY production_order_materials.production_order_id) m ON ((m.production_order_id = o.id)));
revoke all on public.production_order_list from anon, authenticated;
grant select on public.production_order_list to authenticated;

drop view if exists public.bom_item_list;
create view public.bom_item_list
with (security_invoker = true) as
SELECT bi.id,
    bi.company_id,
    bi.bom_id,
    bi.line_no,
    bi.component_product_id,
    bi.quantity_required,
    bi.unit,
    bi.wastage_percentage,
    bi.notes,
    bi.created_at,
    bi.source_type,
    bi.preferred_supplier_id,
    p.sku,
    p.product_name,
    p.product_type,
    p.base_unit AS inventory_unit,
    p.status AS product_status,
    (p.archived_at IS NOT NULL) AS product_archived,
    p.standard_cost
   FROM (bom_items bi
     JOIN products p ON ((p.id = bi.component_product_id)));
revoke all on public.bom_item_list from anon, authenticated;
grant select on public.bom_item_list to authenticated;

drop view if exists public.bom_list;
create view public.bom_list
with (security_invoker = true) as
SELECT b.id,
    b.company_id,
    b.bom_code,
    b.finished_product_id,
    b.version,
    b.status,
    b.effective_from,
    b.effective_to,
    b.output_quantity,
    b.output_unit,
    b.notes,
    b.created_by,
    b.submitted_by,
    b.submitted_at,
    b.approved_by,
    b.approved_at,
    b.review_note,
    b.archived_by,
    b.archived_at,
    b.created_at,
    b.updated_at,
    p.sku,
    p.product_name,
    p.product_type,
    p.status AS product_status,
    ( SELECT count(*) AS count
           FROM bom_items bi
          WHERE (bi.bom_id = b.id)) AS item_count
   FROM (boms b
     JOIN products p ON ((p.id = b.finished_product_id)));
revoke all on public.bom_list from anon, authenticated;
grant select on public.bom_list to authenticated;

drop view if exists public.bom_list_v2;
create view public.bom_list_v2
with (security_invoker = true) as
SELECT b.id,
    b.company_id,
    b.bom_code,
    b.finished_product_id,
    b.version,
    b.status,
    b.effective_from,
    b.effective_to,
    b.output_quantity,
    b.output_unit,
    b.notes,
    b.created_by,
    b.submitted_by,
    b.submitted_at,
    b.approved_by,
    b.approved_at,
    b.review_note,
    b.archived_by,
    b.archived_at,
    b.created_at,
    b.updated_at,
    p.sku,
    p.product_name,
    p.product_type,
    p.status AS product_status,
    ( SELECT count(*) AS count
           FROM bom_items bi
          WHERE (bi.bom_id = b.id)) AS item_count,
    p.gst_rate AS tax_rate,
    p.lead_time_days,
    p.group_head,
    p.minimum_cover_days,
    p.ean
   FROM (boms b
     JOIN products p ON ((p.id = b.finished_product_id)));
revoke all on public.bom_list_v2 from anon, authenticated;
grant select on public.bom_list_v2 to authenticated;

CREATE OR REPLACE FUNCTION public.erp_report(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
  v_f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date;
  v_to      date;
  v_prod    uuid;
  v_cust    uuid;
  v_sup     uuid;
  v_search  text := nullif(btrim(coalesce(v_f ->> 'search', '')), '');
  v_tz      text;
  v_rows    jsonb;
  v_r       text := upper(coalesce(p_report, ''));
begin
  v_company := case
    when v_r in ('PRODUCTS') then private.require_permission('products.read')
    when v_r in ('STOCK_REGISTER', 'STOCK_MOVEMENTS', 'INVENTORY_VALUATION', 'LOW_STOCK') then private.require_permission('inventory.read')
    when v_r in ('PURCHASE_REGISTER', 'GRN_REGISTER', 'SUPPLIER_PURCHASES') then private.require_permission('purchases.read')
    when v_r in ('PRODUCTION_REGISTER', 'MATERIAL_CONSUMPTION', 'PRODUCTION_WASTAGE') then private.require_permission('manufacturing.read')
    when v_r in ('SALES_ORDER_REGISTER', 'CUSTOMER_SALES', 'PRODUCT_SALES', 'DISPATCH') then private.require_permission('sales_orders.read')
    when v_r in ('INVOICE_REGISTER', 'GST_SUMMARY', 'CUSTOMER_OUTSTANDING', 'PAYMENT_COLLECTION') then private.require_permission('invoices.read')
    when v_r = 'SUPPLIER_OUTSTANDING' then private.require_permission('ledger.read') end;
  if v_company is null then
    raise exception 'Unknown report %.', p_report using errcode = 'P0001';
  end if;
  begin
    v_from := coalesce(nullif(v_f ->> 'from', '')::date, date '2000-01-01');
    v_to := coalesce(nullif(v_f ->> 'to', '')::date, private.company_today(v_company));
    v_prod := nullif(v_f ->> 'product_id', '')::uuid;
    v_cust := nullif(v_f ->> 'customer_id', '')::uuid;
    v_sup := nullif(v_f ->> 'supplier_id', '')::uuid;
  exception when others then
    raise exception 'Invalid report filters.' using errcode = 'P0001';
  end;
  if v_to < v_from then
    raise exception 'The end date cannot be before the start date.' using errcode = 'P0001';
  end if;
  v_tz := private.company_tz(v_company);

  if v_r = 'PRODUCTS' then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('id', p.id, 'sku', p.sku, 'product_name', p.product_name,
        'product_type', p.product_type, 'category', c.name, 'unit', p.base_unit, 'hsn_code', p.hsn_code, 'gst_rate', p.gst_rate, 'selling_price', p.selling_price,
        'standard_cost', p.standard_cost, 'reorder_level', p.reorder_level, 'source', p.default_source_type, 'status', p.status,
        'bom', exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED'), 'created', (p.created_at at time zone v_tz)::date) x
      from public.products p left join public.product_categories c on c.id = p.category_id
      where p.company_id = v_company and p.archived_at is null and (v_prod is null or p.id = v_prod)) z;
  elsif v_r in ('STOCK_REGISTER', 'INVENTORY_VALUATION') then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name,
        'product_type', p.product_type, 'unit', p.base_unit, 'on_hand', sum(l.on_hand), 'reserved', sum(l.reserved),
        'available', coalesce(sum(l.on_hand - l.reserved) filter (where l.stock_usage = 'STORAGE'), 0),
        'rejected', coalesce(sum(l.on_hand) filter (where l.stock_usage = 'REJECTED'), 0),
        'average_cost', case when count(*) filter (where l.cost is null) = 0 and sum(l.on_hand) > 0 then round(sum(l.on_hand * l.cost) / sum(l.on_hand), 4) end,
        'value', case when count(*) filter (where l.cost is null) = 0 then round(sum(round(l.on_hand * l.cost, 2)), 2) end,
        'uncosted_quantity', coalesce(sum(l.on_hand) filter (where l.cost is null), 0)) x
      from private.stock_lots(v_company) l join public.products p on p.id = l.product_id
      where (v_prod is null or p.id = v_prod) group by p.id) z;
  elsif v_r = 'LOW_STOCK' then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('product_id', s.product_id, 'sku', s.sku, 'product_name', s.product_name,
        'unit', s.base_unit, 'on_hand', s.on_hand, 'reserved', s.reserved, 'available', s.available, 'reorder_level', s.reorder_level, 'status', s.stock_status) x
      from public.inventory_product_stock s where s.company_id = v_company and s.archived_at is null and s.product_status = 'ACTIVE'
        and (s.stock_status = 'LOW_STOCK' or (s.stock_status = 'OUT_OF_STOCK' and s.has_history)) and (v_prod is null or s.product_id = v_prod)) z;
  elsif v_r = 'STOCK_MOVEMENTS' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'number') into v_rows from (select jsonb_build_object('date', (t.transaction_date at time zone v_tz)::date,
        'number', t.transaction_number, 'type', t.transaction_type, 'sku', p.sku, 'product_name', p.product_name, 'quantity', t.direction * t.quantity, 'unit', t.unit,
        'warehouse', w.warehouse_code, 'location', l.location_code, 'reference', coalesce(t.reference_number, t.reference_type), 'reason', t.reason) x
      from public.inventory_transactions t join public.products p on p.id = t.product_id join public.warehouses w on w.id = t.warehouse_id
      join public.inventory_locations l on l.id = t.location_id
      where t.company_id = v_company and (t.transaction_date at time zone v_tz)::date between v_from and v_to and (v_prod is null or t.product_id = v_prod)
      order by t.transaction_date limit 5000) z;
  elsif v_r = 'PURCHASE_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'po_number') into v_rows from (select jsonb_build_object('id', o.id, 'po_number', o.po_number, 'date', o.po_date,
        'supplier', o.supplier_name, 'status', o.status, 'expected', o.expected_delivery_date, 'taxable', o.taxable_total,
        'gst', o.cgst_total + o.sgst_total + o.igst_total, 'grand_total', o.grand_total,
        'pending_value', (select coalesce(sum(v.pending_value), 0) from public.purchase_order_line_list v where v.purchase_order_id = o.id)) x
      from public.purchase_orders o where o.company_id = v_company and o.po_date between v_from and v_to and (v_sup is null or o.supplier_id = v_sup)
        and (v_prod is null or exists (select 1 from public.purchase_order_lines l where l.purchase_order_id = o.id and l.product_id = v_prod))) z;
  elsif v_r = 'GRN_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'receipt_number') into v_rows from (select jsonb_build_object('id', r.id, 'receipt_number', r.receipt_number,
        'date', r.receipt_date, 'supplier', coalesce(s.display_name, s.legal_name), 'po_number', o.po_number, 'sku', p.sku, 'product_name', p.product_name,
        'received', l.received_quantity, 'accepted', l.accepted_quantity, 'rejected', l.rejected_quantity, 'unit', l.unit,
        'value', coalesce(l.line_value, private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total)), 'status', r.status) x
      from public.goods_receipts r join public.goods_receipt_lines l on l.goods_receipt_id = r.id left join public.products p on p.id = l.product_id
      left join public.suppliers s on s.id = r.supplier_id left join public.purchase_orders o on o.id = r.purchase_order_id
      left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
      where r.company_id = v_company and r.receipt_date between v_from and v_to and (v_sup is null or r.supplier_id = v_sup) and (v_prod is null or l.product_id = v_prod)) z;
  elsif v_r = 'SUPPLIER_PURCHASES' then
    select jsonb_agg(x order by x ->> 'supplier') into v_rows from (select jsonb_build_object('supplier_id', s.id, 'supplier_code', s.supplier_code,
        'supplier', coalesce(s.display_name, s.legal_name),
        'orders', (select count(*) from public.purchase_orders o where o.supplier_id = s.id and o.po_date between v_from and v_to and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')),
        'ordered_value', (select coalesce(sum(grand_total), 0) from public.purchase_orders o where o.supplier_id = s.id and o.po_date between v_from and v_to
                          and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')),
        'received_value', (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r where r.supplier_id = s.id and r.status = 'POSTED'
                           and r.receipt_date between v_from and v_to),
        'paid', (select coalesce(sum(amount), 0) from public.supplier_payments sp where sp.supplier_id = s.id and sp.status = 'RECORDED' and sp.payment_date between v_from and v_to),
        'outstanding', (select payable from private.party_balances(v_company) b where b.supplier_id = s.id limit 1)) x
      from public.suppliers s where s.company_id = v_company and (v_sup is null or s.id = v_sup)) z
    where (x ->> 'orders')::int > 0 or (x ->> 'received_value')::numeric <> 0 or (x ->> 'paid')::numeric <> 0 or coalesce((x ->> 'outstanding')::numeric, 0) <> 0;
  elsif v_r = 'PRODUCTION_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'order_number') into v_rows from (select jsonb_build_object('id', o.id, 'order_number', o.production_order_number,
        'date', o.planned_start_date, 'sku', p.sku, 'product_name', p.product_name, 'unit', o.unit, 'planned', o.planned_quantity,
        'good', (select coalesce(sum(good_quantity), 0) from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'),
        'rejected', (select coalesce(sum(rejected_quantity), 0) from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'),
        'scrap', (select coalesce(sum(scrap_quantity), 0) from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'),
        'status', o.status, 'completed', o.actual_completion_date) x
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and o.planned_start_date between v_from and v_to and (v_prod is null or o.finished_product_id = v_prod)) z;
  elsif v_r = 'MATERIAL_CONSUMPTION' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'order_number') into v_rows from (select jsonb_build_object('date', c.consumption_date,
        'order_number', o.production_order_number, 'finished_sku', fp.sku, 'sku', p.sku, 'product_name', p.product_name, 'unit', c.unit,
        'planned', c.planned_quantity, 'actual', c.actual_quantity, 'difference', c.actual_quantity - c.planned_quantity, 'status', c.status) x
      from public.production_material_consumption c join public.production_orders o on o.id = c.production_order_id
      join public.products p on p.id = c.component_product_id join public.products fp on fp.id = o.finished_product_id
      where c.company_id = v_company and c.consumption_date between v_from and v_to and (v_prod is null or c.component_product_id = v_prod or o.finished_product_id = v_prod)) z;
  elsif v_r = 'PRODUCTION_WASTAGE' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'receipt_number') into v_rows from (select jsonb_build_object('date', r.production_date, 'receipt_number', r.receipt_number,
        'order_number', o.production_order_number, 'sku', p.sku, 'product_name', p.product_name, 'unit', r.unit, 'good', r.good_quantity,
        'rejected', r.rejected_quantity, 'scrap', r.scrap_quantity,
        'loss_percent', case when r.good_quantity + r.rejected_quantity + r.scrap_quantity > 0
                             then round(100 * (r.rejected_quantity + r.scrap_quantity) / (r.good_quantity + r.rejected_quantity + r.scrap_quantity), 1) end,
        'material_over_use', (select coalesce(sum(greatest(c.actual_quantity - c.planned_quantity, 0)), 0) from public.production_material_consumption c
                              where c.production_order_id = o.id and c.status = 'POSTED'),
        'reason', r.rejection_reason) x
      from public.production_output_receipts r join public.production_orders o on o.id = r.production_order_id join public.products p on p.id = r.product_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between v_from and v_to and (r.rejected_quantity > 0 or r.scrap_quantity > 0
        or exists (select 1 from public.production_material_consumption c where c.production_order_id = o.id and c.status = 'POSTED' and c.actual_quantity > c.planned_quantity))
        and (v_prod is null or r.product_id = v_prod)) z;
  elsif v_r = 'SALES_ORDER_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'order_number') into v_rows from (select jsonb_build_object('id', so.id, 'order_number', so.sales_order_number,
        'date', so.order_date, 'customer', so.customer_name_snapshot, 'reference', coalesce(so.customer_reference, so.customer_po_number),
        'status', private.so_v2_status(so.id), 'taxable', so.taxable_total, 'grand_total', so.grand_total, 'delivery', so.requested_delivery_date) x
      from public.sales_orders so where so.company_id = v_company and so.order_date between v_from and v_to and (v_cust is null or so.customer_id = v_cust)
        and (v_prod is null or exists (select 1 from public.sales_order_lines l where l.sales_order_id = so.id and l.product_id = v_prod))) z;
  elsif v_r = 'CUSTOMER_SALES' then
    select jsonb_agg(x order by x ->> 'customer') into v_rows from (select jsonb_build_object('customer_id', c.id, 'customer_code', c.customer_code, 'customer', c.customer_name,
        'orders', (select count(*) from public.sales_orders so where so.customer_id = c.id and so.order_date between v_from and v_to and so.order_status not in ('DRAFT', 'CANCELLED')),
        'order_value', (select coalesce(sum(grand_total), 0) from public.sales_orders so where so.customer_id = c.id and so.order_date between v_from and v_to
                        and so.order_status not in ('DRAFT', 'CANCELLED')),
        'invoiced', (select coalesce(sum(grand_total), 0) from public.sales_invoices i where i.customer_id = c.id and i.status = 'ISSUED' and i.invoice_date between v_from and v_to),
        'collected', (select coalesce(sum(amount_received), 0) from public.customer_payments p where p.customer_id = c.id and p.status = 'RECORDED' and p.receipt_date between v_from and v_to),
        'outstanding', (select coalesce(sum(greatest(private.invoice_balance(i.id), 0)), 0) from public.sales_invoices i where i.customer_id = c.id and i.status = 'ISSUED')) x
      from public.customers c where c.company_id = v_company and (v_cust is null or c.id = v_cust)) z
    where (x ->> 'orders')::int > 0 or (x ->> 'invoiced')::numeric <> 0 or (x ->> 'collected')::numeric <> 0 or (x ->> 'outstanding')::numeric <> 0;
  elsif v_r = 'PRODUCT_SALES' then
    select jsonb_agg(x order by x ->> 'sku') into v_rows from (select jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit,
        'ordered', coalesce(o.q, 0), 'order_value', coalesce(o.v, 0), 'dispatched', coalesce(d.q, 0), 'invoiced', coalesce(i.q, 0), 'invoiced_taxable', coalesce(i.v, 0)) x
      from public.products p
      left join lateral (select sum(l.quantity_ordered - l.quantity_cancelled) q, sum(l.line_total) v from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
                         where l.product_id = p.id and so.order_date between v_from and v_to and so.order_status not in ('DRAFT', 'CANCELLED')
                           and (v_cust is null or so.customer_id = v_cust)) o on true
      left join lateral (select sum(fl.quantity_dispatched) q from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
                         join public.sales_orders so on so.id = f.sales_order_id
                         where fl.product_id = p.id and f.actual_dispatch_at is not null and (f.actual_dispatch_at at time zone v_tz)::date between v_from and v_to
                           and (v_cust is null or so.customer_id = v_cust)) d on true
      left join lateral (select sum(il.quantity) q, sum(il.taxable_value) v from public.sales_invoice_lines il join public.sales_invoices si on si.id = il.invoice_id
                         where il.product_id = p.id and si.status = 'ISSUED' and si.invoice_date between v_from and v_to and (v_cust is null or si.customer_id = v_cust)) i on true
      where p.company_id = v_company and (v_prod is null or p.id = v_prod) and (o.q is not null or d.q is not null or i.q is not null)) z;
  elsif v_r = 'DISPATCH' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'number') into v_rows from (select jsonb_build_object('date', (f.actual_dispatch_at at time zone v_tz)::date,
        'number', f.fulfilment_number, 'order_number', so.sales_order_number, 'customer', so.customer_name_snapshot, 'sku', p.sku, 'product_name', p.product_name,
        'quantity', fl.quantity_dispatched, 'unit', p.base_unit, 'vehicle', f.vehicle_number, 'status', f.fulfilment_status,
        'invoiced', private.so_v2_fulfilment_invoiced(f.id)) x
      from public.fulfilments f join public.fulfilment_lines fl on fl.fulfilment_id = f.id join public.sales_orders so on so.id = f.sales_order_id
      join public.products p on p.id = fl.product_id
      where f.company_id = v_company and f.actual_dispatch_at is not null and fl.quantity_dispatched > 0
        and (f.actual_dispatch_at at time zone v_tz)::date between v_from and v_to and (v_cust is null or so.customer_id = v_cust) and (v_prod is null or fl.product_id = v_prod)) z;
  elsif v_r = 'INVOICE_REGISTER' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'invoice_number') into v_rows from (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number,
        'date', i.invoice_date, 'customer', i.customer_legal_name, 'gstin', i.customer_gstin, 'type', i.invoice_type, 'taxable', i.taxable_subtotal,
        'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'grand_total', i.grand_total, 'paid', i.paid, 'balance', i.balance_due,
        'status', i.display_status, 'due_date', i.due_date) x
      from public.sales_invoice_list i where i.company_id = v_company and i.status in ('ISSUED', 'CANCELLED') and i.invoice_date between v_from and v_to
        and (v_cust is null or i.customer_id = v_cust)
        and (v_prod is null or exists (select 1 from public.sales_invoice_lines l where l.invoice_id = i.id and l.product_id = v_prod))) z;
  elsif v_r = 'GST_SUMMARY' then
    select jsonb_agg(x order by x ->> 'document', (x ->> 'gst_rate')::numeric nulls first, x ->> 'hsn_sac') into v_rows from (
      select jsonb_build_object('document', 'Invoices', 'hsn_sac', coalesce(l.hsn_sac, '—'), 'gst_rate', l.gst_rate, 'taxable', sum(l.taxable_value),
        'cgst', sum(l.cgst_amount), 'sgst', sum(l.sgst_amount), 'igst', sum(l.igst_amount), 'total', sum(l.line_total)) x
      from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
      where i.company_id = v_company and i.status = 'ISSUED' and i.invoice_date between v_from and v_to and (v_cust is null or i.customer_id = v_cust)
        and (v_prod is null or l.product_id = v_prod)
      group by l.hsn_sac, l.gst_rate
      union all
      select jsonb_build_object('document', case n.note_type when 'CREDIT' then 'Credit notes (deduct)' else 'Debit notes (add)' end, 'hsn_sac', coalesce(nl.hsn_sac, '—'),
        'gst_rate', nl.gst_rate, 'taxable', sum(nl.taxable_amount), 'cgst', sum(nl.cgst_amount), 'sgst', sum(nl.sgst_amount), 'igst', sum(nl.igst_amount), 'total', sum(nl.line_total))
      from public.invoice_adjustment_note_lines nl join public.invoice_adjustment_notes n on n.id = nl.note_id
      where n.company_id = v_company and n.status = 'ISSUED' and n.note_date between v_from and v_to and (v_cust is null or n.customer_id = v_cust)
      group by n.note_type, nl.hsn_sac, nl.gst_rate) z;
  elsif v_r = 'CUSTOMER_OUTSTANDING' then
    select jsonb_agg(x order by (x ->> 'receivable')::numeric desc) into v_rows from (select jsonb_build_object('party_id', b.party_id, 'party_code', b.party_code,
        'customer', b.party_name, 'invoice_outstanding', b.invoice_outstanding, 'overdue', b.overdue, 'receivable', b.receivable,
        'open_invoices', (select count(*) from public.sales_invoices i where i.customer_id = b.customer_id and i.status = 'ISSUED' and private.invoice_balance(i.id) > 0)) x
      from private.party_balances(v_company) b where b.customer_id is not null and (v_cust is null or b.customer_id = v_cust)
        and (b.receivable <> 0 or b.invoice_outstanding <> 0)) z;
  elsif v_r = 'SUPPLIER_OUTSTANDING' then
    select jsonb_agg(x order by (x ->> 'payable')::numeric desc) into v_rows from (select jsonb_build_object('party_id', b.party_id, 'party_code', b.party_code,
        'supplier', b.party_name, 'received_value', (select coalesce(sum(private.goods_receipt_value(r.id)), 0) from public.goods_receipts r where r.supplier_id = b.supplier_id and r.status = 'POSTED'),
        'paid', (select coalesce(sum(amount), 0) from public.supplier_payments sp where sp.supplier_id = b.supplier_id and sp.status = 'RECORDED'),
        'payable', b.payable) x
      from private.party_balances(v_company) b where b.supplier_id is not null and (v_sup is null or b.supplier_id = v_sup) and b.payable <> 0) z;
  elsif v_r = 'PAYMENT_COLLECTION' then
    select jsonb_agg(x order by x ->> 'date', x ->> 'receipt_number') into v_rows from (select jsonb_build_object('id', p.id, 'receipt_number', p.receipt_number,
        'date', p.receipt_date, 'customer', c.customer_name, 'method', p.payment_method, 'reference', p.transaction_reference, 'amount', p.amount_received,
        'allocated', (select coalesce(sum(allocated_amount), 0) from public.invoice_payment_allocations a where a.payment_id = p.id and a.status = 'ACTIVE'),
        'invoices', (select string_agg(distinct i.invoice_number, ', ') from public.invoice_payment_allocations a join public.sales_invoices i on i.id = a.invoice_id
                     where a.payment_id = p.id and a.status = 'ACTIVE'),
        'status', p.status) x
      from public.customer_payments p join public.customers c on c.id = p.customer_id
      where p.company_id = v_company and p.receipt_date between v_from and v_to and (v_cust is null or p.customer_id = v_cust)) z;
  end if;

  v_rows := coalesce(v_rows, '[]'::jsonb);
  if v_search is not null then
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) r
    where exists (select 1 from jsonb_each_text(r) e where e.key not in ('id', 'product_id', 'party_id', 'customer_id', 'supplier_id') and e.value ilike '%' || v_search || '%');
  end if;
  return jsonb_build_object('report', v_r, 'from', v_from, 'to', v_to, 'generated_at', now(), 'count', jsonb_array_length(v_rows), 'rows', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.production_report(p_report text, p_from date, p_to date, p_product_id uuid DEFAULT NULL::uuid, p_bom_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_supplier text DEFAULT NULL::text)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid := private.require_permission('production_reports.read');
  v_supplier text := nullif(btrim(coalesce(p_supplier, '')), '');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;

  if p_report = 'ORDERS_SUMMARY' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, o.priority, p.sku, p.product_name, o.bom_code, o.bom_version, o.unit,
        o.planned_quantity, o.completed_quantity, o.rejected_quantity, o.scrap_quantity, o.planned_start_date, o.target_completion_date,
        o.actual_start_date, o.actual_completion_date, sw.warehouse_code as source_warehouse, dw.warehouse_code as destination_warehouse
      from public.production_orders o
      join public.products p on p.id = o.finished_product_id
      join public.warehouses sw on sw.id = o.source_warehouse_id
      join public.warehouses dw on dw.id = o.destination_warehouse_id
      where o.company_id = v_company and o.planned_start_date between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id or o.destination_warehouse_id = p_warehouse_id)
      order by o.planned_start_date desc, o.production_order_number desc) x;

  elsif p_report = 'PLANNED_VS_ACTUAL' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, p.sku, p.product_name, o.unit, o.planned_quantity,
        o.completed_quantity as good_quantity, o.actual_quantity as total_output,
        o.actual_quantity - o.planned_quantity as variance,
        case when o.planned_quantity > 0 then round(o.completed_quantity / o.planned_quantity * 100, 1) end as good_percent_of_plan,
        o.target_completion_date, o.actual_completion_date,
        case when o.actual_completion_date is not null then o.actual_completion_date - o.target_completion_date end as days_late
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and o.status not in ('DRAFT', 'CANCELLED')
        and o.target_completion_date between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id or o.destination_warehouse_id = p_warehouse_id)
      order by o.target_completion_date desc) x;

  elsif p_report in ('RAW_MATERIAL_REQUIREMENTS', 'MATERIAL_SHORTAGE') then
    return query
    select to_jsonb(x) from (
      select sku, product_name, unit, warehouse_code, orders, order_numbers, planned, issued, outstanding,
        reserved_for_orders, available, shortage
      from private.production_material_outlook(v_company, p_warehouse_id, p_product_id)
      where p_report = 'RAW_MATERIAL_REQUIREMENTS' or shortage > 0
      order by shortage desc, sku) x;

  elsif p_report = 'PLANNED_VS_ACTUAL_CONSUMPTION' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, fp.sku as product_sku, cp.sku as component_sku, cp.product_name as component_name, m.unit,
        m.planned_quantity, m.issued_quantity, m.issued_quantity - m.planned_quantity as variance,
        private.ceil_qty(m.quantity_per_unit * o.actual_quantity) as standard_for_actual_output,
        o.actual_quantity as actual_output
      from public.production_orders o
      join public.production_order_materials m on m.production_order_id = o.id
      join public.products fp on fp.id = o.finished_product_id
      join public.products cp on cp.id = m.component_product_id
      where o.company_id = v_company and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')
        and coalesce(o.actual_start_date, o.planned_start_date) between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id)
      order by o.production_order_number desc, m.line_no) x;

  elsif p_report = 'OUTPUT_AND_REJECTIONS' then
    return query
    select to_jsonb(x) from (
      select r.receipt_number, r.production_date, o.production_order_number, p.sku, p.product_name, bt.batch_number, r.unit,
        r.good_quantity, r.rejected_quantity, r.scrap_quantity,
        round((r.rejected_quantity + r.scrap_quantity) / (r.good_quantity + r.rejected_quantity + r.scrap_quantity) * 100, 1) as reject_scrap_percent,
        case when r.rejected_quantity = 0 then null when r.rejected_location_id is not null then 'Stocked (non-saleable)' else 'Recorded only' end as rejected_handling,
        r.rejection_reason, r.quality_status
      from public.production_output_receipts r
      join public.production_orders o on o.id = r.production_order_id
      join public.products p on p.id = r.product_id
      left join public.inventory_batches bt on bt.id = r.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
      order by r.production_date desc, r.receipt_number desc) x;

  elsif p_report = 'FINISHED_GOODS_PRODUCED' then
    return query
    select to_jsonb(x) from (
      select p.sku, p.product_name, r.unit, count(distinct r.production_order_id) as orders, count(*) as receipts,
        sum(r.good_quantity) as good_quantity, sum(r.rejected_quantity) as rejected_quantity, sum(r.scrap_quantity) as scrap_quantity,
        min(r.production_date) as first_date, max(r.production_date) as last_date
      from public.production_output_receipts r
      join public.production_orders o on o.id = r.production_order_id
      join public.products p on p.id = r.product_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
      group by p.sku, p.product_name, r.unit
      order by sum(r.good_quantity) desc) x;

  elsif p_report = 'OUTSOURCING_REGISTER' then
    return query
    select to_jsonb(x) from (
      select o.outsourcing_order_number, o.order_type, o.status, o.supplier_name, o.supplier_reference, p.sku, p.product_name, o.unit,
        o.ordered_quantity, o.received_quantity, o.accepted_quantity, o.rejected_quantity,
        greatest(o.ordered_quantity - o.received_quantity, 0) as pending_quantity,
        o.dispatch_date, o.expected_return_date, o.unit_cost, o.reference_number,
        (o.status not in ('COMPLETED', 'CANCELLED') and o.expected_return_date < private.company_today(v_company)) as overdue
      from public.outsourcing_orders o join public.products p on p.id = o.product_id
      where o.company_id = v_company and o.created_at >= private.company_day_start(v_company, p_from)
        and o.created_at < private.company_day_start(v_company, p_to + 1)
        and (p_product_id is null or o.product_id = p_product_id) and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
        and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
      order by o.created_at desc) x;

  elsif p_report = 'MATERIALS_HELD_BY_SUPPLIERS' then
    return query
    select to_jsonb(x) from (
      select l.external_holder, w.warehouse_code, l.location_code, p.sku, p.product_name, p.base_unit as unit, bt.batch_number, b.source_type,
        b.on_hand as quantity_held,
        (select string_agg(distinct oo.outsourcing_order_number, ', ')
           from public.outsourcing_orders oo
           join public.outsourcing_order_materials om on om.outsourcing_order_id = oo.id
          where oo.external_location_id = l.id and om.component_product_id = b.product_id
            and om.dispatched_quantity - om.returned_quantity - om.consumed_quantity > 0) as open_orders
      from public.inventory_balances b
      join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'EXTERNAL_PROCESSING'
      join public.warehouses w on w.id = b.warehouse_id
      join public.products p on p.id = b.product_id
      join public.inventory_batches bt on bt.id = b.batch_id
      where b.company_id = v_company and b.on_hand > 0
        and (p_product_id is null or b.product_id = p_product_id)
        and (v_supplier is null or l.external_holder ilike '%' || v_supplier || '%')
      order by l.external_holder, p.sku) x;

  elsif p_report = 'OUTSOURCED_RECEIPTS' then
    return query
    select to_jsonb(x) from (
      select r.receipt_number, r.receipt_date, o.outsourcing_order_number, o.order_type, o.supplier_name, r.supplier_document_number,
        p.sku, p.product_name, bt.batch_number, r.unit, r.received_quantity, r.accepted_quantity, r.rejected_quantity,
        r.rejection_disposition, r.rejection_reason, r.unit_cost
      from public.outsourcing_receipts r
      join public.outsourcing_orders o on o.id = r.outsourcing_order_id
      join public.products p on p.id = r.product_id
      left join public.inventory_batches bt on bt.id = r.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
        and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
      order by r.receipt_date desc, r.receipt_number desc) x;

  elsif p_report = 'IN_HOUSE_VS_OUTSOURCED' then
    return query
    select to_jsonb(x) from (
      select p.sku, p.product_name, p.base_unit as unit,
        coalesce(ih.qty, 0) as in_house_good, coalesce(os.qty, 0) as outsourced_accepted,
        coalesce(ih.qty, 0) + coalesce(os.qty, 0) as total,
        case when coalesce(ih.qty, 0) + coalesce(os.qty, 0) > 0
             then round(coalesce(ih.qty, 0) / (coalesce(ih.qty, 0) + coalesce(os.qty, 0)) * 100, 1) end as in_house_percent
      from public.products p
      left join (select r.product_id, sum(r.good_quantity) qty from public.production_output_receipts r
                 join public.production_orders o on o.id = r.production_order_id
                 where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
                   and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
                 group by r.product_id) ih on ih.product_id = p.id
      left join (select r.product_id, sum(r.accepted_quantity) qty from public.outsourcing_receipts r
                 join public.outsourcing_orders o on o.id = r.outsourcing_order_id
                 where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to
                   and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
                   and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
                 group by r.product_id) os on os.product_id = p.id
      where p.company_id = v_company and (ih.qty is not null or os.qty is not null)
        and (p_product_id is null or p.id = p_product_id)
      order by coalesce(ih.qty, 0) + coalesce(os.qty, 0) desc) x;

  elsif p_report = 'BATCH_TRACEABILITY' then
    return query
    select to_jsonb(x) from (
      select r.production_date as date, 'PRODUCTION' as kind, o.production_order_number as order_number, fp.sku as output_sku,
        obt.batch_number as output_batch, r.good_quantity as output_quantity, cp.sku as material_sku, ibt.batch_number as material_batch,
        c.actual_quantity as material_quantity, c.unit as material_unit, obt.is_system_lot as output_is_pooled_lot
      from public.production_output_receipts r
      join public.production_orders o on o.id = r.production_order_id
      join public.products fp on fp.id = r.product_id
      left join public.inventory_batches obt on obt.id = r.batch_id
      join public.production_material_consumption c on c.production_order_id = o.id and c.status = 'POSTED'
      join public.products cp on cp.id = c.component_product_id
      join public.inventory_batches ibt on ibt.id = c.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
      union all
      select r.receipt_date, 'OUTSOURCING', o.outsourcing_order_number, fp.sku, obt.batch_number, r.accepted_quantity,
        cp.sku, ibt.batch_number, mv.quantity, mv.unit, obt.is_system_lot
      from public.outsourcing_receipts r
      join public.outsourcing_orders o on o.id = r.outsourcing_order_id
      join public.products fp on fp.id = r.product_id
      left join public.inventory_batches obt on obt.id = r.batch_id
      left join public.outsourcing_material_movements mv on mv.receipt_id = r.id and mv.status = 'POSTED'
      left join public.products cp on cp.id = mv.component_product_id
      left join public.inventory_batches ibt on ibt.id = mv.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id)
        and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
      order by 1 desc, 3) x;

  elsif p_report = 'COST_SUMMARY' then
    return query select row_data from private.production_cost_rows(v_company, p_from, p_to, p_product_id);

  elsif p_report = 'VARIANCE' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, fp.sku as product_sku, o.unit as output_unit, o.planned_quantity, o.actual_quantity,
        o.actual_quantity - o.planned_quantity as output_variance,
        cp.sku as component_sku, m.unit, private.ceil_qty(m.quantity_per_unit * o.actual_quantity) as standard_for_output,
        private.ceil_qty(m.quantity_per_unit * o.actual_quantity * (1 + m.wastage_percentage / 100)) as allowed_with_wastage,
        m.issued_quantity,
        m.issued_quantity - private.ceil_qty(m.quantity_per_unit * o.actual_quantity) as usage_variance,
        case when o.actual_quantity = 0 then 'NO_OUTPUT'
             when m.issued_quantity > private.ceil_qty(m.quantity_per_unit * o.actual_quantity * (1 + m.wastage_percentage / 100)) then 'OVER_ALLOWANCE'
             when m.issued_quantity < private.ceil_qty(m.quantity_per_unit * o.actual_quantity) then 'BELOW_STANDARD'
             else 'WITHIN_ALLOWANCE' end as assessment
      from public.production_orders o
      join public.production_order_materials m on m.production_order_id = o.id
      join public.products fp on fp.id = o.finished_product_id
      join public.products cp on cp.id = m.component_product_id
      where o.company_id = v_company and o.status in ('IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'ON_HOLD')
        and coalesce(o.actual_completion_date, o.actual_start_date) between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id)
      order by o.production_order_number desc, m.line_no) x;
  else
    raise exception 'Unknown report %.', p_report using errcode = 'P0001';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.production_cost_rows(p_company uuid, p_from date, p_to date, p_product uuid)
 RETURNS TABLE(row_data jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with prod as (
    select o.*, pr.sku, pr.product_name,
      (select count(*) from public.production_material_consumption c where c.production_order_id = o.id and c.status = 'POSTED') as issues,
      (select count(*) from public.production_material_consumption c where c.production_order_id = o.id and c.status = 'POSTED'
         and private.lot_average_cost(c.batch_id) is null) as uncosted_issues,
      (select sum(c.actual_quantity * private.lot_average_cost(c.batch_id)) from public.production_material_consumption c
         where c.production_order_id = o.id and c.status = 'POSTED') as material_cost,
      (select count(*) from public.production_order_materials m join public.products cp on cp.id = m.component_product_id
         where m.production_order_id = o.id and cp.standard_cost is null) as missing_standard,
      (select sum(m.planned_quantity * cp.standard_cost) from public.production_order_materials m
         join public.products cp on cp.id = m.component_product_id where m.production_order_id = o.id) as standard_planned
    from public.production_orders o
    join public.products pr on pr.id = o.finished_product_id
    where o.company_id = p_company and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')
      and (p_product is null or o.finished_product_id = p_product)
      and exists (select 1 from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'
                  and r.production_date between p_from and p_to)
  ),
  outsrc as (
    select o.*, pr.sku, pr.product_name,
      (select count(*) from public.outsourcing_material_movements mv where mv.outsourcing_order_id = o.id and mv.status = 'POSTED'
         and mv.movement_type = 'CONSUMPTION') as issues,
      (select count(*) from public.outsourcing_material_movements mv where mv.outsourcing_order_id = o.id and mv.status = 'POSTED'
         and mv.movement_type = 'CONSUMPTION' and private.lot_average_cost(mv.batch_id) is null) as uncosted_issues,
      (select sum(mv.quantity * private.lot_average_cost(mv.batch_id)) from public.outsourcing_material_movements mv
         where mv.outsourcing_order_id = o.id and mv.status = 'POSTED' and mv.movement_type = 'CONSUMPTION') as material_cost
    from public.outsourcing_orders o
    join public.products pr on pr.id = o.product_id
    where o.company_id = p_company and o.accepted_quantity > 0
      and (p_product is null or o.product_id = p_product)
      and exists (select 1 from public.outsourcing_receipts r where r.outsourcing_order_id = o.id and r.status = 'POSTED'
                  and r.receipt_date between p_from and p_to)
  )
  select jsonb_build_object(
    'order_type', 'PRODUCTION', 'order_number', production_order_number, 'order_id', id, 'status', status, 'sku', sku,
    'product_name', product_name, 'unit', unit, 'good_quantity', completed_quantity, 'actual_quantity', actual_quantity,
    'material_cost', case when issues > 0 and uncosted_issues = 0 then round(material_cost, 2) end,
    'outsourcing_cost', null,
    'total_cost', case when issues > 0 and uncosted_issues = 0 then round(material_cost, 2) end,
    'cost_per_good_unit', case when issues > 0 and uncosted_issues = 0 and completed_quantity > 0 then round(material_cost / completed_quantity, 4) end,
    'standard_estimate_for_output', case when missing_standard = 0 and planned_quantity > 0
                                         then round(standard_planned * actual_quantity / planned_quantity, 2) end,
    'variance', case when issues > 0 and uncosted_issues = 0 and missing_standard = 0 and planned_quantity > 0
                     then round(material_cost - standard_planned * actual_quantity / planned_quantity, 2) end,
    'cost_status', case when issues = 0 then 'NO_MATERIAL_ISSUED' when uncosted_issues > 0 then 'COST_DATA_INCOMPLETE' else 'ACTUAL' end,
    'notes', case when uncosted_issues > 0 then format('%s of %s material issues are from lots with unknown cost', uncosted_issues, issues)
                  when missing_standard > 0 then 'No standard-cost estimate: some components have no standard cost' end)
  from prod
  union all
  select jsonb_build_object(
    'order_type', 'OUTSOURCING', 'order_number', outsourcing_order_number, 'order_id', id, 'status', status, 'sku', sku,
    'product_name', product_name, 'unit', unit, 'good_quantity', accepted_quantity, 'actual_quantity', received_quantity,
    'material_cost', case when issues = 0 then 0 when uncosted_issues = 0 then round(material_cost, 2) end,
    'outsourcing_cost', case when unit_cost is not null then round(unit_cost * accepted_quantity, 2) end,
    'total_cost', case when unit_cost is not null and uncosted_issues = 0 then round(coalesce(material_cost, 0) + unit_cost * accepted_quantity, 2) end,
    'cost_per_good_unit', case when unit_cost is not null and uncosted_issues = 0 and accepted_quantity > 0
                               then round((coalesce(material_cost, 0) + unit_cost * accepted_quantity) / accepted_quantity, 4) end,
    'standard_estimate_for_output', null,
    'variance', null,
    'cost_status', case when unit_cost is null or uncosted_issues > 0 then 'COST_DATA_INCOMPLETE' else 'ACTUAL' end,
    'notes', case when unit_cost is null then 'No price / processing charge recorded on the order'
                  when uncosted_issues > 0 then 'Some material sent to the supplier has unknown cost' end)
  from outsrc;
$function$;

CREATE OR REPLACE FUNCTION public.production_order_v2_save(p_order_id uuid, p_data jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid := private.require_any_permission(array['production_order.create', 'production_order.update']);
  v_today    date := private.company_today(v_company);
  v_data     jsonb := coalesce(p_data, '{}'::jsonb);
  v_prev     jsonb;
  v_order    public.production_orders;
  v_product  public.products;
  v_bom      public.boms;
  v_qty      numeric;
  v_date     date;
  v_wh       uuid;
  v_pid      uuid;
  v_notes    text;
  v_priority text;
  v_bad      record;
  v_from     text;
  v_warn     jsonb := '[]'::jsonb;
  v_post     jsonb;
  v_req      jsonb;
  v_result   jsonb;
  v_complete boolean;
begin
  begin
    v_complete := coalesce((v_data ->> 'complete')::boolean, false);
    v_qty := nullif(btrim(coalesce(v_data ->> 'planned_quantity', '')), '')::numeric;
    v_date := nullif(btrim(coalesce(v_data ->> 'production_date', '')), '')::date;
    v_pid := nullif(btrim(coalesce(v_data ->> 'product_id', '')), '')::uuid;
    v_wh := nullif(btrim(coalesce(v_data ->> 'warehouse_id', '')), '')::uuid;
  exception when others then
    raise exception 'Enter a valid product, planned quantity, production date and location.' using errcode = 'P0001';
  end;
  if v_complete then
    perform private.production_v2_require_complete(v_company);
  end if;

  if p_order_id is null then
    if not private.has_permission(v_company, 'production_order.create') then
      raise exception 'You are not allowed to create production orders (requires production_order.create).' using errcode = '42501';
    end if;
    v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_v2_save');
    if v_prev is not null then return v_prev; end if;
  else
    if p_idempotency_key is not null then
      v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_v2_save');
      if v_prev is not null then return v_prev; end if;
    end if;
    select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
    if not found then
      raise exception 'Production order not found in your company.' using errcode = 'P0001';
    end if;
    if v_order.status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS') then
      raise exception 'A % production order cannot be edited.%', lower(replace(v_order.status, '_', ' ')),
        case when v_order.status = 'COMPLETED' then ' Use "Correct production" to change what was recorded.' else '' end using errcode = 'P0001';
    end if;
    if exists (select 1 from public.production_material_consumption where production_order_id = v_order.id and status = 'POSTED')
       or exists (select 1 from public.production_output_receipts where production_order_id = v_order.id and status = 'POSTED') then
      raise exception 'Materials or output are already recorded for this order. Use "Correct production" instead of editing it.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_order.update') or v_order.created_by = auth.uid()) then
      raise exception 'You can only edit your own production orders (requires production_order.update).' using errcode = '42501';
    end if;
    if v_pid is not null and v_pid <> v_order.finished_product_id
       and exists (select 1 from public.production_material_consumption where production_order_id = v_order.id) then
      raise exception 'The product of an order with posting history cannot be changed. Cancel it and create a new order.' using errcode = 'P0001';
    end if;
  end if;

  v_pid := coalesce(v_pid, v_order.finished_product_id);
  v_qty := coalesce(v_qty, v_order.planned_quantity);
  v_date := coalesce(v_date, v_order.planned_start_date, v_today);
  v_wh := coalesce(v_wh, v_order.source_warehouse_id,
    (select id from public.warehouses where company_id = v_company and is_default and status = 'ACTIVE' limit 1));
  v_notes := case when v_data ? 'remarks' then nullif(btrim(coalesce(v_data ->> 'remarks', '')), '') else v_order.notes end;
  v_priority := coalesce(nullif(v_data ->> 'priority', ''), v_order.priority, 'NORMAL');

  select * into v_product from public.products where id = v_pid and company_id = v_company;
  if not found then
    raise exception 'Choose the finished product to produce.' using errcode = 'P0001';
  end if;
  if v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
    raise exception '% is inactive and cannot be produced.', v_product.sku using errcode = 'P0001';
  end if;
  v_bom := private.production_v2_active_bom(v_company, v_product.id);
  if v_bom.id is null then
    raise exception '% has no active BOM. Add its components first.', v_product.sku using errcode = 'P0001';
  end if;
  if v_product.base_unit <> v_bom.output_unit then
    raise exception 'The unit of % (%) no longer matches its BOM output unit (%).', v_product.sku, v_product.base_unit, v_bom.output_unit using errcode = 'P0001';
  end if;
  if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
    raise exception 'Enter a planned quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if private.is_whole_unit(v_product.base_unit) and v_qty <> trunc(v_qty) then
    raise exception '% is counted in whole pieces (%): enter a whole planned quantity.', v_product.sku, v_product.base_unit using errcode = 'P0001';
  end if;
  if v_wh is null or not exists (select 1 from public.warehouses where id = v_wh and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Choose the production location (an active warehouse).' using errcode = 'P0001';
  end if;
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'Remarks are limited to 2000 characters.' using errcode = 'P0001';
  end if;
  if v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be LOW, NORMAL, HIGH or URGENT.' using errcode = 'P0001';
  end if;
  select * into v_bad from private.bom_requirement_lines(v_bom.id, v_qty) r where not r.unit_matches or not r.component_active limit 1;
  if found then
    raise exception 'Component % cannot be planned: %.', v_bad.sku,
      case when not v_bad.unit_matches then format('BOM unit %s differs from inventory unit %s', v_bad.unit, v_bad.inventory_unit)
           else 'it is inactive' end using errcode = 'P0001';
  end if;

  if p_order_id is null then
    insert into public.production_orders (company_id, production_order_number, finished_product_id, bom_id, bom_code, bom_version, unit,
      planned_quantity, priority, source_warehouse_id, destination_warehouse_id, planned_start_date, target_completion_date, notes, created_by)
    values (v_company, private.next_document_number(v_company, 'PRD'), v_product.id, v_bom.id, v_bom.bom_code, v_bom.version, v_product.base_unit,
      v_qty, v_priority, v_wh, v_wh, v_date, v_date, v_notes, auth.uid())
    returning * into v_order;
    perform private.log_production_event(v_company, v_order.id, 'CREATED', null, 'DRAFT', null,
      jsonb_build_object('production_order_number', v_order.production_order_number, 'bom_code', v_bom.bom_code, 'bom_version', v_bom.version,
        'planned_quantity', v_qty, 'production_date', v_date));
  else
    v_from := v_order.status;
    if v_order.status <> 'DRAFT' then
      perform private.release_order_reservations(v_order, 'RELEASED');
    end if;
    update public.production_orders
    set finished_product_id = v_product.id, bom_id = v_bom.id, bom_code = v_bom.bom_code, bom_version = v_bom.version, unit = v_product.base_unit,
        planned_quantity = v_qty, priority = v_priority, source_warehouse_id = v_wh, destination_warehouse_id = v_wh,
        planned_start_date = v_date, target_completion_date = v_date, notes = v_notes, status = 'DRAFT', actual_start_date = null
    where id = v_order.id
    returning * into v_order;
    delete from public.production_order_materials m
    where m.production_order_id = v_order.id
      and not exists (select 1 from public.production_material_consumption c where c.order_material_id = m.id)
      and m.component_product_id not in (select r.component_product_id from private.bom_requirement_lines(v_bom.id, v_qty) r);
    perform private.log_production_event(v_company, v_order.id, 'UPDATED', v_from, 'DRAFT',
      case when v_from <> 'DRAFT' then 'Edited: reservations released and materials recalculated.' end,
      jsonb_build_object('planned_quantity', v_qty, 'production_date', v_date, 'bom_code', v_bom.bom_code, 'bom_version', v_bom.version));
  end if;

  perform private.production_v2_snapshot(v_order);
  v_warn := private.production_v2_open_and_reserve(v_company, v_order.id);

  if v_complete then
    v_post := private.production_v2_post(v_company, v_order.id, v_data);
    v_warn := v_warn || coalesce(v_post -> 'warnings', '[]'::jsonb);
  else
    v_req := private.production_v2_requirements(v_order.id);
    v_warn := v_warn || private.production_v2_shortage_warnings(v_req);
  end if;

  v_result := jsonb_build_object('order_id', v_order.id, 'production_order_number', v_order.production_order_number,
    'status', (select status from public.production_orders where id = v_order.id),
    'bom_code', v_bom.bom_code, 'bom_version', v_bom.version,
    'requirements', coalesce(v_req, private.production_v2_requirements(v_order.id)),
    'completion', v_post, 'warnings', v_warn);
  if p_idempotency_key is not null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_result);
  end if;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_bom_item_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  select status into v_status from public.boms where id = coalesce(new.bom_id, old.bom_id);
  if v_status not in ('DRAFT', 'REJECTED') then
    raise exception 'Components of a % BOM cannot be changed. Create a new version instead.', lower(v_status) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;


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

create or replace function private.erp_reset_kept_tables()
returns table (table_name text, label text, company_scoped boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('companies', 'Company record', true),
    ('company_settings', 'Company settings', true),
    ('profiles', 'User profiles', true),
    ('user_roles', 'Role assignments', true),
    ('user_invitations', 'User invitations', true),
    ('roles', 'Roles', false),
    ('permissions', 'Permissions', false),
    ('role_permissions', 'Role permissions', false),
    ('audit_logs', 'Audit log', true),
    ('erp_reset_runs', 'Reset history', true),
    ('erp_reset_backup_attestations', 'Reset backup records', true),
    ('invoice_settings', 'Invoice settings', true),
    ('billing_number_sequences', 'Billing number series', true),
    ('inventory_number_sequences', 'Inventory number series', true),
    ('approval_workflows', 'Approval workflows', true),
    ('approval_workflow_stages', 'Approval workflow stages', true),
    ('notification_preferences', 'Notification preferences', true),
    ('notification_sync_state', 'Notification sync state', true),
    ('error_events', 'System error log', true),
    ('amazon_settings', 'Amazon settings', true),
    ('amazon_connections', 'Amazon connections', true),
    ('warehouses', 'Warehouses', true),
    ('inventory_locations', 'Warehouse locations', true),
    ('products', 'Products', true),
    ('product_categories', 'Product categories', true),
    ('documents', 'Documents', true),
    ('document_versions', 'Document files', true)
  ) t (table_name, label, company_scoped);
$$;

create or replace function private.erp_force_reset_tables()
returns table (table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select t.table_name, t.category, t.label from private.erp_reset_tables() t
  union all
  select * from (values
    ('products', 'Products & catalogue', 'Products'),
    ('product_categories', 'Products & catalogue', 'Product categories'),
    ('warehouses', 'Warehouses & locations', 'Warehouses'),
    ('inventory_locations', 'Warehouses & locations', 'Warehouse locations'),
    ('documents', 'Documents', 'Documents (except company-level documents)'),
    ('document_versions', 'Documents', 'Document file versions')
  ) x (table_name, category, label);
$$;


-- 2. Triggers
drop trigger if exists products_zz_version on public.products;
drop trigger if exists products_zz_clear_reason on public.products;
drop trigger if exists products_version_created on public.products;
drop trigger if exists inventory_transactions_a_snapshot on public.inventory_transactions;
drop trigger if exists bom_items_zz_version on public.bom_items;
drop trigger if exists bom_items_zz_remember on public.bom_items;
drop trigger if exists boms_zz_version on public.boms;
drop trigger if exists boms_no_overlap on public.boms;
drop trigger if exists production_orders_zz_snapshot on public.production_orders;
drop trigger if exists production_order_materials_zz_snapshot on public.production_order_materials;
drop trigger if exists production_order_materials_zz_removed on public.production_order_materials;
drop trigger if exists product_versions_guard on public.product_versions;

-- 3. Functions
drop function if exists public.product_version_history(uuid);
drop function if exists public.bom_version_history(uuid);
drop function if exists public.bom_version_details_save(uuid, text, text);
drop function if exists public.production_bom_save_and_activate(uuid, uuid, date, date, numeric, text, jsonb, uuid, text, text);
drop function if exists public.draft_version_check(text, uuid);
drop function if exists public.draft_refresh_versions(text, uuid);
drop function if exists private.bom_version_lifecycle(public.boms, date);
drop function if exists private.bom_item_remember_version();
drop function if exists private.order_material_standard_cost(public.production_order_materials);
drop function if exists private.production_material_snapshot();
drop function if exists private.production_material_removed();
drop function if exists private.production_order_snapshot();
drop function if exists private.production_revision_reason();
drop function if exists private.bom_item_snapshot(uuid, uuid, uuid);
drop function if exists private.bom_lifecycle_status(text, date, date, date);
drop function if exists private.bom_no_overlap();
drop function if exists private.bom_stamp_on_approval();
drop function if exists private.bom_item_stamp_version();
drop function if exists private.inventory_tx_snapshot();
drop function if exists private.hist_product(uuid, uuid, text, text);
drop function if exists private.product_legacy_version(uuid);
drop function if exists private.product_current_version(uuid);
drop function if exists private.guard_product_version();
drop function if exists private.product_version_clear_reason();
drop function if exists private.product_version_on_update();
drop function if exists private.product_version_on_insert();
drop function if exists private.product_version_add(public.products, text, text, jsonb, boolean, timestamptz);
drop function if exists private.product_version_attrs(public.products);

-- 4. Columns and tables
alter table public.production_order_materials drop column if exists component_version_id, drop column if exists component_sku_snapshot,
  drop column if exists component_name_snapshot, drop column if exists standard_cost_snapshot, drop column if exists costing_basis,
  drop column if exists snapshot_taken_at;
alter table public.production_orders drop column if exists product_version_id, drop column if exists product_sku_snapshot,
  drop column if exists product_name_snapshot, drop column if exists snapshot_taken_at;
alter table public.boms drop column if exists change_reason, drop column if exists process_instructions;
alter table public.bom_items drop column if exists component_version_id;
alter table public.inventory_transactions drop column if exists product_version_id, drop column if exists sku_snapshot,
  drop column if exists product_name_snapshot;
alter table public.products drop column if exists change_reason;
drop table if exists public.production_order_revisions;
drop table if exists public.product_versions;

commit;

notify pgrst, 'reload schema';
