-- =============================================================================
-- ALTON ERP V2 — Stock register, stock reconciliation and duplicate-safe
-- production orders. Non-destructive: one new table, new read-only
-- functions, one trigger, and private.idempotency_begin() redefined with the
-- same signature and behaviour plus logging. No data is changed.
--
-- 1. Stock position (public.inventory_stock_position / _detail), per product,
--    optionally for one warehouse:
--      on hand, reserved, available (= storage on hand − reserved)
--      pending PO        = ordered − accepted on posted GRNs, open orders only
--                          (amendments change the ordered quantity; reversed
--                          GRNs no longer count as received)
--      pending production = planned − good output of open production orders
--      expected incoming = pending PO + pending production
--      BOM required      = material still to issue to open production orders
--                          (their BOM snapshot incl. wastage) that is not yet
--                          reserved for them
--      BOM shortage      = GREATEST(BOM required − available, 0)
--      ledger on hand    = sum of posted movements (discrepancy indicator)
--    Pending PO and production are never added to on-hand stock.
-- 2. public.inventory_reconciliation(): every lot / location where the balance
--    differs from the ledger, reserved differs from the active reservations,
--    stock is negative or over-reserved, plus ledger stock without a balance row.
-- 3. Production orders: public.production_order_requests (unique per company
--    and request id) records the request id that created each order, written
--    by trigger from the request id of the creating call. The existing request-id table already returns the
--    first result to a repeated request; this makes the identity part of the
--    order itself. Repeated requests are written to the audit log.
-- Rollback: supabase/rollback/20261111090000_stock_register_reliability_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Duplicate-safe creation of production orders
-- -----------------------------------------------------------------------------
-- A separate table (not a production_orders column) so the views that select
-- production_orders.* in earlier migrations stay re-appliable.
create table if not exists public.production_order_requests (
  production_order_id uuid primary key,
  company_id          uuid not null references public.companies (id) on delete restrict,
  request_id          uuid not null,
  operation           text not null check (length(operation) between 1 and 60),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  constraint production_order_requests_request_unique unique (company_id, request_id),
  constraint production_order_requests_order_fk foreign key (production_order_id, company_id)
    references public.production_orders (id, company_id) on delete restrict
);

comment on table public.production_order_requests is
  'Request id (idempotency key) of the call that created each production order. Unique per company: one request can never create two orders.';

alter table public.production_order_requests enable row level security;
revoke all on public.production_order_requests from anon, authenticated;
grant select on public.production_order_requests to authenticated;
grant all on public.production_order_requests to service_role;
drop policy if exists production_order_requests_select on public.production_order_requests;
create policy production_order_requests_select on public.production_order_requests for select to authenticated
  using (private.has_permission(company_id, 'manufacturing.read'));
drop trigger if exists production_order_requests_append_only on public.production_order_requests;
create trigger production_order_requests_append_only before update on public.production_order_requests
  for each row execute function private.prevent_history_mutation();

-- Same as 20261012090100 (same signature and results) plus:
--   * the request id and operation are kept for the rest of the transaction
--     (app.request_id / app.request_operation) so records created by the call
--     can carry it;
--   * a repeated request is written to the audit log.
create or replace function private.idempotency_begin(p_company uuid, p_key uuid, p_operation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.inventory_requests;
begin
  if p_key is null then
    raise exception 'A request id (idempotency key) is required.' using errcode = 'P0001';
  end if;
  -- A concurrent call with the same id waits here until the first one commits.
  insert into public.inventory_requests (company_id, idempotency_key, operation, created_by)
  values (p_company, p_key, p_operation, auth.uid())
  on conflict do nothing;
  if found then
    perform set_config('app.request_id', p_key::text, true);
    perform set_config('app.request_operation', p_operation, true);
    return null;
  end if;
  select * into v_existing from public.inventory_requests where company_id = p_company and idempotency_key = p_key;
  if v_existing.operation <> p_operation then
    raise exception 'This request id was already used for a different operation.' using errcode = 'P0001';
  end if;
  perform private.write_audit_log(p_company, 'request.duplicate_returned', 'request', p_key::text,
    jsonb_build_object('operation', p_operation, 'first_requested_at', v_existing.created_at,
      'record', coalesce(v_existing.result ->> 'production_order_number', v_existing.result ->> 'receipt_number', v_existing.result ->> 'po_number')));
  return coalesce(v_existing.result, '{}'::jsonb) || jsonb_build_object('duplicate', true);
end;
$$;

revoke all on function private.idempotency_begin(uuid, uuid, text) from public, anon, authenticated;

-- Records the request that created the order. A second order for the same
-- request id violates the unique key and the whole creation is rolled back.
create or replace function private.production_order_record_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op text := coalesce(current_setting('app.request_operation', true), '');
begin
  if v_op in ('production_v2_save', 'production_order_create') and nullif(current_setting('app.request_id', true), '') is not null then
    insert into public.production_order_requests (production_order_id, company_id, request_id, operation, created_by)
    values (new.id, new.company_id, current_setting('app.request_id', true)::uuid, v_op, auth.uid());
  end if;
  return null;
end;
$$;

revoke all on function private.production_order_record_request() from public, anon, authenticated;

drop trigger if exists production_orders_record_request on public.production_orders;
create trigger production_orders_record_request
  after insert on public.production_orders
  for each row execute function private.production_order_record_request();

-- -----------------------------------------------------------------------------
-- 2. Stock position per product
-- -----------------------------------------------------------------------------
create or replace function private.open_production_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'ON_HOLD'];
$$;

revoke all on function private.open_production_statuses() from public, anon, authenticated;

create or replace function private.stock_position(p_company uuid, p_warehouse uuid)
returns table (product_id uuid, on_hand numeric, reserved numeric, available numeric, ledger_on_hand numeric, pending_po numeric,
  open_po_count bigint, pending_production numeric, bom_required numeric, last_movement_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with bal as (
    select b.product_id, sum(b.on_hand) as on_hand,
      coalesce(sum(b.reserved) filter (where l.stock_usage = 'STORAGE'), 0) as reserved,
      coalesce(sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE'), 0) as available,
      max(b.last_movement_at) as last_at
    from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
    where b.company_id = p_company and (p_warehouse is null or b.warehouse_id = p_warehouse)
    group by b.product_id
  ),
  led as (
    select t.product_id, sum(t.direction * t.quantity) as q from public.inventory_transactions t
    where t.company_id = p_company and (p_warehouse is null or t.warehouse_id = p_warehouse)
    group by t.product_id
  ),
  po as (
    select v.product_id, sum(v.pending_quantity) as q, count(distinct v.purchase_order_id) as n
    from public.purchase_order_line_list v join public.purchase_orders o on o.id = v.purchase_order_id
    where o.company_id = p_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') and v.line_type = 'GOODS'
      and v.product_id is not null and v.pending_quantity > 0 and (p_warehouse is null or o.warehouse_id = p_warehouse)
    group by v.product_id
  ),
  prod as (
    select o.finished_product_id as product_id, sum(greatest(o.planned_quantity - o.completed_quantity, 0)) as q
    from public.production_orders o
    where o.company_id = p_company and o.status = any (private.open_production_statuses())
      and (p_warehouse is null or o.destination_warehouse_id = p_warehouse)
    group by o.finished_product_id
  ),
  bom as (
    select m.component_product_id as product_id,
      sum(greatest(m.planned_quantity - m.issued_quantity - coalesce(r.q, 0), 0)) as q
    from public.production_order_materials m
    join public.production_orders o on o.id = m.production_order_id
    left join lateral (
      select sum(sr.quantity - sr.fulfilled_quantity - sr.released_quantity) as q from public.stock_reservations sr
      where sr.reference_type = 'PRODUCTION_ORDER' and sr.reference_id = o.id and sr.product_id = m.component_product_id
        and sr.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    ) r on true
    where o.company_id = p_company and o.status = any (private.open_production_statuses())
      and (p_warehouse is null or o.source_warehouse_id = p_warehouse)
    group by m.component_product_id
  )
  select p.id, coalesce(bal.on_hand, 0), coalesce(bal.reserved, 0), coalesce(bal.available, 0), coalesce(led.q, 0),
    coalesce(po.q, 0), coalesce(po.n, 0), coalesce(prod.q, 0), coalesce(bom.q, 0), bal.last_at
  from public.products p
  left join bal on bal.product_id = p.id
  left join led on led.product_id = p.id
  left join po on po.product_id = p.id
  left join prod on prod.product_id = p.id
  left join bom on bom.product_id = p.id
  where p.company_id = p_company;
$$;

revoke all on function private.stock_position(uuid, uuid) from public, anon, authenticated;

-- p_filters: {warehouse_id?, product_id?, category_id?, product_type?, search?, include_inactive?,
--             shortage_only?, pending_po_only?, discrepancy_only?, low_only?}
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

-- Drill-down for one product: lots by warehouse and location, open purchase
-- orders, recent goods receipts, production orders (making it or using it),
-- and BOM components / where used. Purchase and production lists need their
-- own read permissions.
create or replace function public.inventory_stock_position_detail(p_product_id uuid, p_warehouse_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.read');
  v_p        public.products;
  v_purch    boolean;
  v_mfg      boolean;
begin
  select * into v_p from public.products where id = p_product_id and company_id = v_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  v_purch := private.has_permission(v_company, 'purchases.read');
  v_mfg := private.has_permission(v_company, 'manufacturing.read') or private.has_permission(v_company, 'production_bom.read');
  return jsonb_build_object(
    'product', jsonb_build_object('id', v_p.id, 'sku', v_p.sku, 'product_name', v_p.product_name, 'unit', v_p.base_unit),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('warehouse_code', w.warehouse_code, 'location_code', l.location_code, 'stock_usage', l.stock_usage,
        'batch_number', bt.batch_number, 'source_type', b.source_type, 'on_hand', b.on_hand, 'reserved', b.reserved,
        'available', case when l.stock_usage = 'STORAGE' then b.on_hand - b.reserved else 0 end,
        'ledger_on_hand', (select coalesce(sum(t.direction * t.quantity), 0) from public.inventory_transactions t where t.batch_id = b.batch_id and t.location_id = b.location_id))
        order by w.warehouse_code, l.location_code, bt.batch_number nulls first)
      from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id join public.warehouses w on w.id = b.warehouse_id
      join public.inventory_batches bt on bt.id = b.batch_id
      where b.product_id = v_p.id and (p_warehouse_id is null or b.warehouse_id = p_warehouse_id) and (b.on_hand <> 0 or b.reserved <> 0)), '[]'::jsonb),
    'purchase_orders', case when v_purch then coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'po_number', o.po_number, 'status', o.status,
        'supplier', o.supplier_name, 'expected', o.expected_delivery_date, 'ordered', v.ordered_quantity, 'accepted', v.accepted_quantity,
        'pending', v.pending_quantity) order by o.expected_delivery_date nulls last, o.po_number)
      from public.purchase_order_line_list v join public.purchase_orders o on o.id = v.purchase_order_id
      where v.product_id = v_p.id and o.company_id = v_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') and v.line_type = 'GOODS'
        and v.pending_quantity > 0 and (p_warehouse_id is null or o.warehouse_id = p_warehouse_id)), '[]'::jsonb) end,
    'goods_receipts', case when v_purch then coalesce((select jsonb_agg(x order by x ->> 'date' desc) from (
        select jsonb_build_object('id', r.id, 'receipt_number', r.receipt_number, 'date', r.receipt_date, 'status', r.status, 'po_number', o.po_number,
          'accepted', l.accepted_quantity, 'rejected', l.rejected_quantity, 'supplier_invoice_number', d.supplier_invoice_number,
          'supplier_challan_number', d.supplier_challan_number) x
        from public.goods_receipt_lines l join public.goods_receipts r on r.id = l.goods_receipt_id
        left join public.purchase_orders o on o.id = r.purchase_order_id
        left join public.purchase_document_refs d on d.goods_receipt_id = r.id
        where l.product_id = v_p.id and r.company_id = v_company and (p_warehouse_id is null or r.warehouse_id = p_warehouse_id or o.warehouse_id = p_warehouse_id)
        order by r.receipt_date desc, r.receipt_number desc limit 20) z), '[]'::jsonb) end,
    'production_orders', case when v_mfg then coalesce((select jsonb_agg(x order by x ->> 'production_order_number') from (
        select jsonb_build_object('id', o.id, 'production_order_number', o.production_order_number, 'status', o.status, 'role', 'OUTPUT',
          'planned', o.planned_quantity, 'completed', o.completed_quantity, 'pending', greatest(o.planned_quantity - o.completed_quantity, 0)) x
        from public.production_orders o
        where o.finished_product_id = v_p.id and o.company_id = v_company and o.status = any (private.open_production_statuses())
          and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
        union all
        select jsonb_build_object('id', o.id, 'production_order_number', o.production_order_number, 'status', o.status, 'role', 'MATERIAL',
          'planned', m.planned_quantity, 'issued', m.issued_quantity,
          'reserved', coalesce((select sum(sr.quantity - sr.fulfilled_quantity - sr.released_quantity) from public.stock_reservations sr
             where sr.reference_type = 'PRODUCTION_ORDER' and sr.reference_id = o.id and sr.product_id = v_p.id
               and sr.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0))
        from public.production_order_materials m join public.production_orders o on o.id = m.production_order_id
        where m.component_product_id = v_p.id and o.company_id = v_company and o.status = any (private.open_production_statuses())
          and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id)) z), '[]'::jsonb) end,
    'bom_components', case when v_mfg then coalesce((select jsonb_agg(jsonb_build_object('sku', c.sku, 'product_name', c.product_name, 'unit', bi.unit,
        'quantity_per_output', bi.quantity_required, 'output_quantity', b.output_quantity, 'wastage_percentage', bi.wastage_percentage,
        'bom_code', b.bom_code, 'version', b.version) order by bi.line_no)
      from public.boms b join public.bom_items bi on bi.bom_id = b.id join public.products c on c.id = bi.component_product_id
      where b.finished_product_id = v_p.id and b.company_id = v_company and b.status = 'APPROVED'
        and b.effective_from <= private.company_today(v_company) and (b.effective_to is null or b.effective_to >= private.company_today(v_company))), '[]'::jsonb) end,
    'used_in', case when v_mfg then coalesce((select jsonb_agg(jsonb_build_object('sku', f.sku, 'product_name', f.product_name, 'bom_code', b.bom_code,
        'version', b.version, 'quantity_per_output', bi.quantity_required, 'output_quantity', b.output_quantity, 'wastage_percentage', bi.wastage_percentage) order by f.sku)
      from public.bom_items bi join public.boms b on b.id = bi.bom_id join public.products f on f.id = b.finished_product_id
      where bi.component_product_id = v_p.id and b.company_id = v_company and b.status = 'APPROVED'), '[]'::jsonb) end,
    'can_see_purchases', v_purch, 'can_see_production', v_mfg);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Stock reconciliation: ledger vs balances, reservations, negatives
-- -----------------------------------------------------------------------------
create or replace function public.inventory_reconciliation(p_product_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_rows    jsonb;
begin
  with lots as (
    select b.product_id, b.batch_id, b.location_id, b.warehouse_id, b.on_hand, b.reserved from public.inventory_balances b
    where b.company_id = v_company and (p_product_id is null or b.product_id = p_product_id)
  ),
  led as (
    select t.product_id, t.batch_id, t.location_id, t.warehouse_id, sum(t.direction * t.quantity) as q from public.inventory_transactions t
    where t.company_id = v_company and (p_product_id is null or t.product_id = p_product_id)
    group by t.product_id, t.batch_id, t.location_id, t.warehouse_id
  ),
  res as (
    select r.batch_id, r.location_id, sum(r.quantity - r.fulfilled_quantity - r.released_quantity) as q from public.stock_reservations r
    where r.company_id = v_company and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') and (p_product_id is null or r.product_id = p_product_id)
    group by r.batch_id, r.location_id
  ),
  issues as (
    select coalesce(lots.product_id, led.product_id) as product_id, coalesce(lots.batch_id, led.batch_id) as batch_id,
      coalesce(lots.location_id, led.location_id) as location_id, coalesce(lots.warehouse_id, led.warehouse_id) as warehouse_id,
      lots.on_hand, led.q as ledger_on_hand, lots.reserved, res.q as reservations,
      array_remove(array[
        case when lots.batch_id is null then 'LEDGER_WITHOUT_BALANCE' end,
        case when lots.batch_id is not null and lots.on_hand <> coalesce(led.q, 0) then 'BALANCE_DIFFERS_FROM_LEDGER' end,
        case when lots.batch_id is not null and lots.reserved <> coalesce(res.q, 0) then 'RESERVED_DIFFERS_FROM_RESERVATIONS' end,
        case when lots.on_hand < 0 then 'NEGATIVE_STOCK' end,
        case when lots.reserved < 0 or lots.reserved > lots.on_hand then 'OVER_RESERVED' end], null) as problems
    from lots
    full join led on led.batch_id = lots.batch_id and led.location_id = lots.location_id
    left join res on res.batch_id = coalesce(lots.batch_id, led.batch_id) and res.location_id = coalesce(lots.location_id, led.location_id)
    where lots.batch_id is not null or coalesce(led.q, 0) <> 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit,
      'warehouse_code', w.warehouse_code, 'location_code', l.location_code, 'batch_number', bt.batch_number,
      'on_hand', i.on_hand, 'ledger_on_hand', coalesce(i.ledger_on_hand, 0), 'difference', coalesce(i.on_hand, 0) - coalesce(i.ledger_on_hand, 0),
      'reserved', i.reserved, 'active_reservations', coalesce(i.reservations, 0), 'problems', to_jsonb(i.problems))
      order by p.sku, w.warehouse_code, l.location_code), '[]'::jsonb)
  into v_rows
  from issues i
  join public.products p on p.id = i.product_id
  left join public.warehouses w on w.id = i.warehouse_id
  left join public.inventory_locations l on l.id = i.location_id
  left join public.inventory_batches bt on bt.id = i.batch_id
  where cardinality(i.problems) > 0;

  return jsonb_build_object('as_of', now(), 'product_id', p_product_id, 'issues', jsonb_array_length(v_rows), 'rows', v_rows,
    'checked_lots', (select count(*) from public.inventory_balances b where b.company_id = v_company and (p_product_id is null or b.product_id = p_product_id)),
    'checked_movements', (select count(*) from public.inventory_transactions t where t.company_id = v_company and (p_product_id is null or t.product_id = p_product_id)));
end;
$$;

revoke all on function public.inventory_stock_position(jsonb) from public, anon;
revoke all on function public.inventory_stock_position_detail(uuid, uuid) from public, anon;
revoke all on function public.inventory_reconciliation(uuid) from public, anon;
grant execute on function public.inventory_stock_position(jsonb) to authenticated;
grant execute on function public.inventory_stock_position_detail(uuid, uuid) to authenticated;
grant execute on function public.inventory_reconciliation(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 4. ERP reset: the request ids are purged before the production orders
-- (same list as 20261109090000 plus production_order_requests).
-- -----------------------------------------------------------------------------
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

revoke all on function private.erp_reset_tables() from public, anon, authenticated;

notify pgrst, 'reload schema';
