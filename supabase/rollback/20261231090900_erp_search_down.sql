-- Rollback of 20261231090900_erp_search.
--
-- Restores the four search functions exactly as the earlier migrations left them, drops the search helpers, the related-record search
-- functions and the trigram indexes. No data is changed (the migration wrote none). The pg_trgm extension is kept: other objects may use it.

-- Functions as 20261111090000 / 20261218090000 / 20261108090000 left them.
create or replace function public.inventory_stock_position(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.read');
  v_f        jsonb := coalesce(p_filters, '{}'::jsonb);
  v_wh       uuid;
  v_prod     uuid;
  v_cat      uuid;
  v_type     text := nullif(v_f ->> 'product_type', '');
  v_search   text := nullif(btrim(coalesce(v_f ->> 'search', '')), '');
  v_inactive boolean := coalesce((v_f ->> 'include_inactive')::boolean, false);
  v_rows     jsonb;
begin
  begin
    v_wh := nullif(v_f ->> 'warehouse_id', '')::uuid;
    v_prod := nullif(v_f ->> 'product_id', '')::uuid;
    v_cat := nullif(v_f ->> 'category_id', '')::uuid;
  exception when others then
    raise exception 'Invalid stock register filters.' using errcode = 'P0001';
  end;
  if v_wh is not null and not exists (select 1 from public.warehouses where id = v_wh and company_id = v_company) then
    raise exception 'Warehouse not found in your company.' using errcode = 'P0001';
  end if;

  with r as (
    select p.id, p.sku, p.product_name, p.barcode, p.category_id, c.name as category_name, p.product_type, p.base_unit, p.status, p.reorder_level,
      p.reorder_level_days, p.lead_time_days, s.*, ps.stock_status, ps.has_history,
      greatest(s.bom_required - s.available, 0) as bom_shortage,
      s.pending_po + s.pending_production as expected_incoming
    from public.products p
    join private.stock_position(v_company, v_wh) s on s.product_id = p.id
    left join public.product_categories c on c.id = p.category_id
    left join public.inventory_product_stock ps on ps.product_id = p.id
    where p.company_id = v_company and p.archived_at is null
      and (v_inactive or p.status = 'ACTIVE')
      and (v_prod is null or p.id = v_prod)
      and (v_cat is null or p.category_id = v_cat)
      and (v_type is null or p.product_type = v_type)
      and (v_search is null or p.sku ilike '%' || v_search || '%' or p.product_name ilike '%' || v_search || '%' or p.barcode ilike '%' || v_search || '%'
           or p.supplier_model_number ilike '%' || v_search || '%')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', id, 'sku', sku, 'product_name', product_name, 'category_id', category_id, 'category_name', category_name,
      'product_type', product_type, 'unit', base_unit, 'product_status', status,
      'on_hand', on_hand, 'reserved', reserved, 'available', available,
      'pending_po_quantity', pending_po, 'open_po_count', open_po_count, 'pending_production_quantity', pending_production,
      'expected_incoming_quantity', expected_incoming, 'bom_required_quantity', bom_required, 'bom_shortage_quantity', bom_shortage,
      'ledger_on_hand', ledger_on_hand, 'discrepancy', ledger_on_hand <> on_hand,
      'stock_status', stock_status, 'low_stock', coalesce(stock_status in ('LOW_STOCK', 'FULLY_RESERVED') or (stock_status = 'OUT_OF_STOCK' and has_history), false),
      'reorder_level', reorder_level, 'reorder_level_days', reorder_level_days, 'lead_time_days', lead_time_days,
      'last_movement_at', last_movement_at) order by sku), '[]'::jsonb)
  into v_rows
  from r
  where (not coalesce((v_f ->> 'shortage_only')::boolean, false) or bom_shortage > 0)
    and (not coalesce((v_f ->> 'pending_po_only')::boolean, false) or pending_po > 0)
    and (not coalesce((v_f ->> 'discrepancy_only')::boolean, false) or ledger_on_hand <> on_hand)
    and (not coalesce((v_f ->> 'low_only')::boolean, false)
         or coalesce(stock_status in ('LOW_STOCK', 'FULLY_RESERVED') or (stock_status = 'OUT_OF_STOCK' and has_history), false));

  return jsonb_build_object('warehouse_id', v_wh, 'as_of', now(), 'rows', v_rows);
end;
$$;

create or replace function public.bom_component_search(p_term text, p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_term    text := left(btrim(coalesce(p_term, '')), 80);
  v_like    text;
begin
  if v_term = '' then return '[]'::jsonb; end if;
  v_like := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((
    select jsonb_agg(r order by r ->> 'rank', r ->> 'sku')
    from (
      select jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'base_unit', p.base_unit,
        'product_type', p.product_type, 'status', case when p.archived_at is not null then 'ARCHIVED' else p.status end,
        'barcode', p.barcode, 'ean', p.ean, 'model_number', p.model_number, 'supplier_model_number', p.supplier_model_number,
        'bom_lines', (select count(*) from public.bom_items bi join public.boms b on b.id = bi.bom_id
                      where bi.company_id = v_company and bi.component_product_id = p.id and b.status <> 'ARCHIVED'),
        'rank', case when lower(p.sku) = lower(v_term) or p.barcode = v_term or p.ean = v_term then '0' else '1' end) as r
      from public.products p
      where p.company_id = v_company
        and (p.sku ilike v_like or p.product_name ilike v_like or p.model_number ilike v_like or p.supplier_model_number ilike v_like
             or p.barcode = v_term or p.ean = v_term or p.barcode ilike v_like or p.ean ilike v_like)
      order by (lower(p.sku) = lower(v_term) or p.barcode = v_term or p.ean = v_term) desc, p.sku
      limit greatest(1, least(coalesce(p_limit, 20), 50))
    ) s), '[]'::jsonb);
end;
$$;

create or replace function public.bom_bulk_current_boms(p_search text default null, p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_search  text := nullif(btrim(coalesce(p_search, '')), '');
  v_today   date := private.company_today(v_company);
begin
  return coalesce((
    select jsonb_agg(r order by r ->> 'sku') from (
      select jsonb_build_object('bom_id', b.id, 'bom_code', b.bom_code, 'version', b.version, 'lifecycle', private.bom_version_lifecycle(b, v_today),
        'effective_from', b.effective_from, 'finished_product_id', p.id, 'sku', p.sku, 'product_name', p.product_name,
        'product_type', p.product_type, 'item_count', (select count(*) from public.bom_items i where i.bom_id = b.id)) as r
      from public.boms b join public.products p on p.id = b.finished_product_id
      where b.company_id = v_company and b.status = 'APPROVED'
        and b.version = (select max(x.version) from public.boms x where x.company_id = v_company and x.finished_product_id = b.finished_product_id and x.status = 'APPROVED')
        and (v_search is null or p.sku ilike '%' || v_search || '%' or p.product_name ilike '%' || v_search || '%' or b.bom_code ilike '%' || v_search || '%')
      order by p.sku
      limit greatest(1, least(coalesce(p_limit, 200), 2000))) s), '[]'::jsonb);
end;
$$;

create or replace function public.global_search(p_term text, p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_term    text := btrim(coalesce(p_term, ''));
  v_like    text;
  v_lim     int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_out     jsonb := '[]'::jsonb;
begin
  if v_company is null then
    raise exception 'No active company.' using errcode = '42501';
  end if;
  if length(v_term) < 2 then
    return '[]'::jsonb;
  end if;
  v_like := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if private.has_permission(v_company, 'products.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Product', 'id', id, 'reference', sku, 'title', product_name,
        'subtitle', initcap(replace(lower(product_type), '_', ' ')) || coalesce(' · HSN ' || hsn_code, ''), 'link', '/products/' || id) x
      from public.products where company_id = v_company and archived_at is null
        and (sku ilike v_like or product_name ilike v_like or coalesce(hsn_code, '') ilike v_like or coalesce(barcode, '') ilike v_like)
      order by (lower(sku) = lower(v_term)) desc, sku limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'customers.read') or private.has_permission(v_company, 'suppliers.read') or private.has_permission(v_company, 'ledger.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', case when p.is_customer and p.is_supplier then 'Customer / supplier'
          when p.is_customer then 'Customer' else 'Supplier' end, 'id', p.id, 'reference', p.party_code,
        'title', coalesce(c.customer_name, s.display_name, s.legal_name), 'subtitle', coalesce(c.gstin, s.gstin, coalesce(c.customer_code, s.supplier_code)),
        'link', '/ledger/' || p.id) x
      from public.parties p left join public.customers c on c.id = p.customer_id left join public.suppliers s on s.id = p.supplier_id
      where p.company_id = v_company and (coalesce(c.customer_name, '') ilike v_like or coalesce(c.legal_name, '') ilike v_like or coalesce(s.legal_name, '') ilike v_like
        or coalesce(s.display_name, '') ilike v_like or p.party_code ilike v_like or coalesce(c.customer_code, '') ilike v_like or coalesce(s.supplier_code, '') ilike v_like
        or coalesce(c.gstin, s.gstin, '') ilike v_like)
      order by 1 limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'purchases.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Purchase order', 'id', id, 'reference', po_number, 'title', supplier_name,
        'subtitle', po_date || ' · ' || initcap(replace(lower(status), '_', ' ')), 'link', '/purchase-orders/' || id) x
      from public.purchase_orders where company_id = v_company and (po_number ilike v_like or supplier_name ilike v_like or coalesce(reference_number, '') ilike v_like)
      order by po_date desc limit v_lim) z), '[]'::jsonb);
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Goods receipt', 'id', r.id, 'reference', r.receipt_number,
        'title', coalesce(s.display_name, s.legal_name, 'No supplier'), 'subtitle', r.receipt_date || case when r.status = 'REVERSED' then ' · reversed' else '' end,
        'link', '/goods-receipts/' || r.id) x
      from public.goods_receipts r left join public.suppliers s on s.id = r.supplier_id
      where r.company_id = v_company and (r.receipt_number ilike v_like or coalesce(r.supplier_document_number, '') ilike v_like)
      order by r.receipt_date desc limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'manufacturing.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Production order', 'id', o.id, 'reference', o.production_order_number,
        'title', p.sku || ' — ' || p.product_name, 'subtitle', trim_scale(o.planned_quantity) || ' ' || o.unit || ' · ' || initcap(replace(lower(o.status), '_', ' ')),
        'link', '/production/orders/' || o.id) x
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and (o.production_order_number ilike v_like or p.sku ilike v_like)
      order by o.created_at desc limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'sales_orders.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', 'Sales order', 'id', id, 'reference', sales_order_number,
        'title', customer_name_snapshot, 'subtitle', order_date || coalesce(' · ref ' || coalesce(customer_reference, customer_po_number), ''), 'link', '/sales/orders/' || id) x
      from public.sales_orders where company_id = v_company and (sales_order_number ilike v_like or customer_name_snapshot ilike v_like
        or coalesce(customer_reference, '') ilike v_like or coalesce(customer_po_number, '') ilike v_like)
      order by order_date desc limit v_lim) z), '[]'::jsonb);
  end if;
  if private.has_permission(v_company, 'invoices.read') then
    v_out := v_out || coalesce((select jsonb_agg(x) from (select jsonb_build_object('module', case when is_proforma then 'Proforma invoice' else 'Invoice' end, 'id', id,
        'reference', coalesce(invoice_number, proforma_number, 'Draft'), 'title', customer_legal_name,
        'subtitle', invoice_date || ' · ' || initcap(replace(lower(status), '_', ' ')) || ' · ' || grand_total, 'link', '/billing/invoices/' || id) x
      from public.sales_invoices where company_id = v_company and status <> 'DISCARDED'
        and (coalesce(invoice_number, '') ilike v_like or coalesce(proforma_number, '') ilike v_like or customer_legal_name ilike v_like)
      order by invoice_date desc limit v_lim) z), '[]'::jsonb);
  end if;
  return v_out;
end;
$$;

drop index if exists public.products_search_trgm;
drop index if exists public.boms_search_trgm;
drop index if exists public.production_orders_search_trgm;
drop index if exists public.outsourcing_orders_search_trgm;
drop index if exists public.inventory_transactions_search_trgm;
drop index if exists public.inventory_batches_search_trgm;
drop index if exists public.suppliers_search_trgm;
drop function if exists public.bom_search(text, text, integer);
drop function if exists public.production_order_search(text, text, integer);
drop function if exists public.outsourcing_order_search(text, text, integer);
drop function if exists private.bom_search_ids(text, integer);
drop function if exists private.production_order_search_ids(text, integer);
drop function if exists private.outsourcing_order_search_ids(text, integer);
drop function if exists private.product_search_text(public.products);
drop function if exists private.search_match(text, text[]);
drop function if exists private.search_patterns(text);
