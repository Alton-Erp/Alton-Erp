-- =============================================================================
-- ERP search: one matching rule for Product Master, BOM, Inventory, Production and Outsourcing
--
-- Rule (documented in docs/ERP_SEARCH.md): the search text is normalised (trimmed, whitespace collapsed, case ignored, at most 8 words of
-- 60 characters); EVERY word must occur as a substring (anywhere — start, middle or end) in at least one searchable field of the record or
-- of its related records. "mic", "eram", "basin white", "white basin" and "ALTON  basin" all find "ALTON Premium Ceramic Wash Basin White".
-- LIKE wildcards typed by the user (% _ \) are matched literally. An empty search matches everything.
--
--   * private.search_patterns(text) / private.search_match(text, text[]) — the rule in SQL (immutable helpers).
--   * Related-record search (security INVOKER, company-scoped, so the caller's row-level security applies exactly as on the list views);
--     public RPCs bom_search / production_order_search / outsourcing_order_search return the matching rows of the existing list views:
--       private.bom_search_ids                 — BOMs by code, version, finished product or ANY component (name, SKU, barcode, EAN, description, model)
--       private.production_order_search_ids    — production orders by number, status, product, BOM, warehouses, components and output batches / receipts
--       private.outsourcing_order_search_ids   — outsourcing orders by number, vendor (name, code), product, components, challans, receipts, movements
--   * Existing searches moved to the rule (from their latest text): stock position (Inventory overview), BOM component picker, current BOMs,
--     and the product part of the global search.
--   * pg_trgm GIN indexes on the searched columns, only where the extension is available (Supabase); elsewhere plain ILIKE is used.
--
-- Read only: nothing here writes data. Rollback: supabase/rollback/20261231090900_erp_search_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The matching rule
-- -----------------------------------------------------------------------------
create or replace function private.search_patterns(p_input text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  -- Distinct words in typed order, each as an escaped %word% pattern.
  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' order by o), '{}')
  from (
    select left(t.w, 60) as w, min(t.o) as o
    from unnest(regexp_split_to_array(lower(btrim(regexp_replace(left(coalesce(p_input, ''), 200), '\s+', ' ', 'g'))), ' ')) with ordinality t (w, o)
    where t.w <> ''
    group by 1
    order by min(t.o)
    limit 8) x;
$$;

create or replace function private.search_match(p_haystack text, p_patterns text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Every word somewhere in the haystack (case-insensitive substring); no words = match.
  select coalesce(bool_and(coalesce(p_haystack, '') ilike pat escape '\'), true) from unnest(p_patterns) pat;
$$;

-- Searchable text of a product (all fields the Product Master searches, plus its category).
create or replace function private.product_search_text(p public.products)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws(' ', p.sku, p.product_name, p.barcode, p.ean, p.description, p.brand, p.model_number, p.supplier_model_number, p.supplier_product_name,
    p.group_head, p.hsn_code, p.product_type, p.default_source_type, p.base_unit,
    (select c.name || ' ' || coalesce(c.code, '') from public.product_categories c where c.id = p.category_id));
$$;

revoke all on function private.search_patterns(text) from public, anon;
revoke all on function private.search_match(text, text[]) from public, anon;
revoke all on function private.product_search_text(public.products) from public, anon;
grant execute on function private.search_patterns(text), private.search_match(text, text[]), private.product_search_text(public.products) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Related-record search (security invoker: the caller's row-level security decides what is found)
-- -----------------------------------------------------------------------------
create or replace function private.bom_search_ids(p_search text, p_limit integer default 2000)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select b.id
  from public.boms b
  join public.products fp on fp.id = b.finished_product_id
  cross join (select private.search_patterns(p_search) as pats) q
  where b.company_id = private.current_company_id() and cardinality(q.pats) > 0
    and private.search_match(concat_ws(' ', b.bom_code, 'v' || b.version, b.version::text, b.status, b.notes, private.product_search_text(fp),
          (select string_agg(concat_ws(' ', cp.sku, cp.product_name, cp.barcode, cp.ean, cp.description, cp.model_number, cp.supplier_model_number, cp.supplier_product_name), ' ')
           from public.bom_items i join public.products cp on cp.id = i.component_product_id where i.bom_id = b.id)), q.pats)
  order by b.updated_at desc, b.id
  limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
$$;

create or replace function private.production_order_search_ids(p_search text, p_limit integer default 2000)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id
  from public.production_order_list o
  cross join (select private.search_patterns(p_search) as pats) q
  where o.company_id = private.current_company_id() and cardinality(q.pats) > 0
    and private.search_match(concat_ws(' ', o.production_order_number, o.status, o.priority, o.bom_code, 'v' || o.bom_version, o.sku, o.product_name,
          o.product_sku_snapshot, o.product_name_snapshot, o.source_warehouse_code, o.destination_warehouse_code, o.notes,
          (select string_agg(concat_ws(' ', m.component_sku_snapshot, m.component_name_snapshot, cp.sku, cp.product_name, cp.barcode, cp.description), ' ')
           from public.production_order_materials m left join public.products cp on cp.id = m.component_product_id where m.production_order_id = o.id),
          (select string_agg(concat_ws(' ', r.receipt_number, r.batch_number, r.good_location_code, r.good_warehouse_code), ' ')
           from public.production_output_list r where r.production_order_id = o.id),
          (select string_agg(concat_ws(' ', c.batch_number, c.transaction_number, c.warehouse_code, c.location_code), ' ')
           from public.production_consumption_list c where c.production_order_id = o.id)), q.pats)
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
$$;

create or replace function private.outsourcing_order_search_ids(p_search text, p_limit integer default 2000)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id
  from public.outsourcing_order_list o
  cross join (select private.search_patterns(p_search) as pats) q
  where o.company_id = private.current_company_id() and cardinality(q.pats) > 0
    and private.search_match(concat_ws(' ', o.outsourcing_order_number, o.order_type, o.status, o.supplier_name,
          -- The vendor master record (linked, or named on the order): its code and names.
          (select string_agg(concat_ws(' ', s.supplier_code, s.legal_name, s.display_name), ' ') from public.suppliers s
           where s.company_id = o.company_id and (s.id = o.supplier_id or lower(btrim(s.legal_name)) = lower(btrim(o.supplier_name))
                  or lower(btrim(s.display_name)) = lower(btrim(o.supplier_name)))),
          o.supplier_reference, o.reference_number, o.sku, o.product_name, o.bom_code, o.notes, o.destination_warehouse_code, o.external_location_code, o.external_holder,
          (select string_agg(concat_ws(' ', m.sku, m.product_name, cp.description, cp.barcode), ' ')
           from public.outsourcing_material_list m left join public.products cp on cp.id = m.component_product_id where m.outsourcing_order_id = o.id),
          (select string_agg(concat_ws(' ', r.receipt_number, r.supplier_document_number, r.batch_number, r.accepted_transaction_number), ' ')
           from public.outsourcing_receipt_list r where r.outsourcing_order_id = o.id),
          (select string_agg(concat_ws(' ', v.out_transaction_number, v.batch_number, v.movement_type, v.notes), ' ')
           from public.outsourcing_movement_list v where v.outsourcing_order_id = o.id)), q.pats)
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(p_limit, 2000), 1), 5000);
$$;

revoke all on function private.bom_search_ids(text, integer) from public, anon;
revoke all on function private.production_order_search_ids(text, integer) from public, anon;
revoke all on function private.outsourcing_order_search_ids(text, integer) from public, anon;
grant execute on function private.bom_search_ids(text, integer), private.production_order_search_ids(text, integer),
  private.outsourcing_order_search_ids(text, integer) to authenticated;

-- The matching rows of the existing list views, as one JSON array (each element = one view row, all columns), newest / code order,
-- after the status filter, at most p_limit (default 2000, max 5000). Security invoker: the views and tables keep their own row-level
-- security; nothing outside the caller's company or permissions is returned. They return jsonb rather than "setof <view>" on purpose:
-- a function typed by a view's row type would pin the view, and later migrations that drop and re-create these views would fail.
--   p_status: null = all; bom_search 'ACTIVE' = not archived; the order searches 'OPEN' = not completed / cancelled; otherwise that status.
create or replace function public.bom_search(p_search text, p_status text default null, p_limit integer default 2000)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.bom_code, x.version desc), '[]'::jsonb)
  from (
    select v.* from public.bom_list_v2 v
    where v.id in (select private.bom_search_ids(p_search, 5000))
      and (p_status is null or (p_status = 'ACTIVE' and v.status <> 'ARCHIVED') or v.status = p_status)
    order by v.bom_code, v.version desc
    limit least(greatest(coalesce(p_limit, 2000), 1), 5000)) x;
$$;

create or replace function public.production_order_search(p_search text, p_status text default null, p_limit integer default 2000)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id), '[]'::jsonb)
  from (
    select v.* from public.production_order_list v
    where v.id in (select private.production_order_search_ids(p_search, 5000))
      and (p_status is null or (p_status = 'OPEN' and v.status not in ('COMPLETED', 'CANCELLED')) or v.status = p_status)
    order by v.created_at desc, v.id
    limit least(greatest(coalesce(p_limit, 2000), 1), 5000)) x;
$$;

create or replace function public.outsourcing_order_search(p_search text, p_status text default null, p_limit integer default 2000)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id), '[]'::jsonb)
  from (
    select v.* from public.outsourcing_order_list v
    where v.id in (select private.outsourcing_order_search_ids(p_search, 5000))
      and (p_status is null or (p_status = 'OPEN' and v.status not in ('COMPLETED', 'CANCELLED')) or v.status = p_status)
    order by v.created_at desc, v.id
    limit least(greatest(coalesce(p_limit, 2000), 1), 5000)) x;
$$;

-- -----------------------------------------------------------------------------
-- 3. Trigram indexes for substring search (only where pg_trgm is available, e.g. Supabase; plain ILIKE elsewhere)
-- -----------------------------------------------------------------------------
do $$
declare
  v_schema text;
  i        record;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_trgm') then
    raise notice 'pg_trgm is not available: substring search uses ILIKE without trigram indexes.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      create extension pg_trgm with schema extensions;
    else
      create extension pg_trgm;
    end if;
  end if;
  select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  for i in select * from (values
      ('products_search_trgm', 'products', array['sku', 'product_name', 'barcode', 'ean', 'description', 'brand', 'model_number', 'supplier_model_number', 'hsn_code']),
      ('boms_search_trgm', 'boms', array['bom_code']),
      ('production_orders_search_trgm', 'production_orders', array['production_order_number', 'product_sku_snapshot', 'product_name_snapshot']),
      ('outsourcing_orders_search_trgm', 'outsourcing_orders', array['outsourcing_order_number', 'supplier_name', 'supplier_reference', 'reference_number']),
      ('inventory_transactions_search_trgm', 'inventory_transactions', array['transaction_number', 'reference_number']),
      ('inventory_batches_search_trgm', 'inventory_batches', array['batch_number']),
      ('suppliers_search_trgm', 'suppliers', array['supplier_code', 'legal_name', 'display_name'])) x (name, tbl, cols)
  loop
    execute format('create index if not exists %I on public.%I using gin (%s)', i.name, i.tbl,
      (select string_agg(format('%I %I.gin_trgm_ops', c, v_schema), ', ') from unnest(i.cols) c));
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Existing searches moved to the rule (each from its latest text; changed lines marked)
-- -----------------------------------------------------------------------------
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
      -- ERP search rule: every word anywhere in the product's searchable fields (20261231090900).
      and (v_search is null or private.search_match(private.product_search_text(p), private.search_patterns(v_search)))
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
        -- ERP search rule (20261231090900): an exact barcode / EAN, or every word anywhere in the product's searchable fields.
        and (p.barcode = v_term or p.ean = v_term or private.search_match(private.product_search_text(p), private.search_patterns(v_term)))
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
        -- ERP search rule (20261231090900): BOM code / version, finished product or any component.
        and (v_search is null or b.id in (select private.bom_search_ids(v_search, 5000)))
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
        -- ERP search rule (20261231090900): every word anywhere in the product's searchable fields.
        and private.search_match(private.product_search_text(products), private.search_patterns(v_term))
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

-- -----------------------------------------------------------------------------
-- 5. Grants: signed-in users only (row-level security and the functions' own checks apply); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.bom_search(text, text, integer)',
    'public.production_order_search(text, text, integer)',
    'public.outsourcing_order_search(text, text, integer)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
