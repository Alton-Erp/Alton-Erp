-- =============================================================================
-- Whole-piece (PCS) quantities
--
-- Root cause this fixes: a BOM stores "quantity_required per output_quantity
-- units". Planning divided the two and rounded UP TO 3 DECIMALS only, so a BOM
-- such as "2 PCS per 70 finished units" planned 2 / 70 x 10 = 0.286 PCS for 10
-- units. That fractional plan was then reserved, issued and posted to the
-- stock ledger (which accepted any 3-decimal quantity for every unit), which
-- left balances such as 78.571 PCS. Nothing anywhere checked the unit.
--
-- Policy (documented in docs/WHOLE_PIECE_QUANTITIES.md):
--   * Units counted in whole pieces: private.whole_unit_codes() (PCS, NOS, SET,
--     PAIR and their common aliases). Every other unit (KG, M, L ...) keeps its
--     3-decimal behaviour unchanged.
--   * BOM: component quantity_required and output_quantity stay a ratio
--     ("N pieces per M finished units"), but both must be whole numbers for
--     whole-piece units when a BOM is submitted or approved. Drafts may hold a
--     fraction while they are being corrected.
--   * Planning: requirement = quantity_required x planned x (1 + wastage%)
--     / output_quantity, wastage applied BEFORE rounding, then rounded UP to the
--     next whole piece. The theoretical (unrounded, 3 dp) requirement is still
--     returned as base_requirement so users can see the BOM ratio.
--   * Execution: every physical quantity of a whole-piece item (orders, issues,
--     output, outsourcing dispatch / return / receipt / consumption, purchase
--     order lines, goods receipts, reservations, adjustments, counts and the
--     stock ledger itself) must be a whole number. Enforced by triggers, so no
--     code path (current or future RPC) can bypass it.
--   * History is never changed. Existing fractional records are reported by
--     private.whole_unit_findings / public.whole_unit_quantity_audit and can be
--     reconciled only through the existing approved stock adjustment / count
--     workflow, which may post a fractional correction ONLY when it leaves the
--     balance whole. Exact reversals of historical postings remain allowed.
--
-- Additive and re-runnable: functions are create-or-replace with unchanged
-- signatures, triggers are drop-if-exists / create. No table is altered and no
-- data is modified.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Unit policy
-- -----------------------------------------------------------------------------
create or replace function private.whole_unit_codes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[];
$$;

create or replace function private.is_whole_unit(p_unit text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select upper(btrim(coalesce(p_unit, ''))) = any(private.whole_unit_codes());
$$;

-- Planned (procurement / issue) quantity: whole pieces rounded up for
-- whole-piece units, otherwise the existing 3-decimal round-up.
create or replace function private.plan_qty(p_value numeric, p_unit text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when private.is_whole_unit(p_unit) then ceil(round(p_value, 9)) else private.ceil_qty(p_value) end;
$$;

revoke all on function private.whole_unit_codes() from public, anon, authenticated;
revoke all on function private.is_whole_unit(text) from public, anon, authenticated;
revoke all on function private.plan_qty(numeric, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Material requirements: round up to whole pieces at the planning boundary
--    (same columns as before; non-whole units use exactly the old formulas).
--    Whole-piece units multiply before dividing so 2/3 x 3 is exactly 2.
-- -----------------------------------------------------------------------------
create or replace function private.bom_requirement_lines(p_bom_id uuid, p_quantity numeric)
returns table (
  line_no int, component_product_id uuid, sku text, product_name text, product_type text, unit text, inventory_unit text,
  component_active boolean, quantity_per_unit numeric, wastage_percentage numeric,
  base_requirement numeric, wastage_allowance numeric, total_requirement numeric, unit_matches boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select bi.line_no, p.id, p.sku, p.product_name, p.product_type, bi.unit, p.base_unit,
    (p.status = 'ACTIVE' and p.archived_at is null),
    round(bi.quantity_required / b.output_quantity, 6),
    bi.wastage_percentage,
    x.base, x.with_wastage - x.base, x.total,
    bi.unit = p.base_unit
  from public.boms b
  join public.bom_items bi on bi.bom_id = b.id
  join public.products p on p.id = bi.component_product_id
  cross join lateral (
    select
      case when private.is_whole_unit(bi.unit)
        then private.ceil_qty(round(bi.quantity_required * p_quantity / b.output_quantity, 9))
        else private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity) end as base,
      case when private.is_whole_unit(bi.unit)
        then private.ceil_qty(round(bi.quantity_required * p_quantity * (100 + bi.wastage_percentage) / (100 * b.output_quantity), 9))
        else private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity * (1 + bi.wastage_percentage / 100)) end as with_wastage,
      case when private.is_whole_unit(bi.unit)
        then ceil(round(bi.quantity_required * p_quantity * (100 + bi.wastage_percentage) / (100 * b.output_quantity), 9))
        else private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity * (1 + bi.wastage_percentage / 100)) end as total
  ) x
  where b.id = p_bom_id
  order by bi.line_no;
$$;

revoke all on function private.bom_requirement_lines(uuid, numeric) from public, anon, authenticated;

comment on function private.bom_requirement_lines(uuid, numeric) is
  'Requirement per BOM line for a planned output. base_requirement = theoretical requirement (3 dp, before wastage); '
  'wastage_allowance = theoretical wastage; total_requirement = planned quantity: whole pieces rounded up (after wastage) '
  'for whole-piece units, 3 decimals rounded up otherwise.';

-- Standard material for the actual output of an order (completion check).
create or replace function private.material_standard_for_output(p_order public.production_orders, p_material public.production_order_materials)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_whole_unit(p_material.unit) then coalesce(
      (select ceil(round(bi.quantity_required * p_order.actual_quantity / b.output_quantity, 9))
       from public.boms b join public.bom_items bi on bi.bom_id = b.id and bi.component_product_id = p_material.component_product_id
       where b.id = p_order.bom_id),
      ceil(round(p_material.quantity_per_unit * p_order.actual_quantity, 6)))
    else private.ceil_qty(p_material.quantity_per_unit * p_order.actual_quantity)
  end;
$$;

revoke all on function private.material_standard_for_output(public.production_orders, public.production_order_materials) from public, anon, authenticated;

create or replace function private.production_discrepancies(p_order public.production_orders)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(d), '[]'::jsonb) from (
    select jsonb_build_object('type', 'OUTPUT_SHORT', 'planned', p_order.planned_quantity, 'actual', p_order.actual_quantity) as d
    where p_order.actual_quantity < p_order.planned_quantity
    union all
    select jsonb_build_object('type', 'MATERIAL_UNDER_ISSUED', 'sku', p.sku, 'issued', m.issued_quantity, 'expected', s.expected, 'unit', m.unit)
    from public.production_order_materials m
    join public.products p on p.id = m.component_product_id
    cross join lateral (select private.material_standard_for_output(p_order, m) as expected) s
    where m.production_order_id = p_order.id
      and m.issued_quantity < s.expected
  ) x;
$$;

revoke all on function private.production_discrepancies(public.production_orders) from public, anon, authenticated;

-- Planning screen: same as before plus the whole-piece check on the planned output.
create or replace function public.production_bom_requirements(p_bom_id uuid, p_quantity numeric, p_warehouse_id uuid default null)
returns table (
  line_no int, component_product_id uuid, sku text, product_name text, product_type text, unit text, inventory_unit text,
  quantity_per_unit numeric, wastage_percentage numeric, base_requirement numeric, wastage_allowance numeric,
  total_requirement numeric, on_hand numeric, reserved numeric, available numeric, shortage numeric,
  suggested_quantity numeric, reorder_level numeric, line_status text, message text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_plan.create', 'production_bom.read', 'manufacturing.read']);
  v_unit    text;
begin
  select output_unit into v_unit from public.boms where id = p_bom_id and company_id = v_company;
  if not found then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Enter a planned quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if private.is_whole_unit(v_unit) and p_quantity <> trunc(p_quantity) then
    raise exception 'Enter a whole number of % to plan: % is counted in whole pieces.', v_unit, v_unit using errcode = 'P0001';
  end if;
  if p_warehouse_id is not null and not exists (select 1 from public.warehouses where id = p_warehouse_id and company_id = v_company) then
    raise exception 'Warehouse not found in your company.' using errcode = 'P0001';
  end if;
  return query
  select r.line_no, r.component_product_id, r.sku, r.product_name, r.product_type, r.unit, r.inventory_unit,
    r.quantity_per_unit, r.wastage_percentage, r.base_requirement, r.wastage_allowance, r.total_requirement,
    s.on_hand, s.reserved,
    case when r.unit_matches then s.available end,
    case when r.unit_matches then greatest(r.total_requirement - s.available, 0) end,
    case when r.unit_matches then private.plan_qty(greatest(r.total_requirement + coalesce(p.reorder_level, 0) - s.available,
                                                            greatest(r.total_requirement - s.available, 0)), r.unit) end,
    p.reorder_level,
    case
      when not r.unit_matches then 'UNIT_MISMATCH'
      when not r.component_active then 'INACTIVE'
      when s.available >= r.total_requirement then 'SUFFICIENT'
      when s.available > 0 then 'PARTIAL'
      else 'SHORTAGE'
    end,
    case
      when not r.unit_matches then format('BOM unit %s differs from inventory unit %s; no conversion is configured, so availability is not calculated.', r.unit, r.inventory_unit)
      when not r.component_active then 'Component is inactive or archived.'
      when private.is_whole_unit(r.unit) and (s.on_hand <> trunc(s.on_hand) or s.reserved <> trunc(s.reserved))
        then 'Stock of this item includes a fractional quantity that must be reconciled (see the whole-piece quantity audit).'
      when s.available >= r.total_requirement then null
      when s.available > 0 then 'Only part of the requirement is available.'
      else 'No usable stock available.'
    end
  from private.bom_requirement_lines(p_bom_id, p_quantity) r
  join public.products p on p.id = r.component_product_id
  cross join lateral private.storage_stock(v_company, r.component_product_id, p_warehouse_id) s
  order by r.line_no;
end;
$$;

-- Reservation: whole pieces only for whole-piece items. A legacy order whose
-- open requirement is fractional is refused with an explanation (never rounded
-- silently); a fractional legacy balance only offers its whole pieces.
create or replace function public.production_reserve_materials(
  p_order_id        uuid,
  p_allow_partial   boolean default false,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('production_material.reserve');
  v_today     date := private.company_today(v_company);
  v_previous  jsonb;
  v_order     public.production_orders;
  v_line      record;
  v_bal       record;
  v_need      numeric;
  v_take      numeric;
  v_whole     boolean;
  v_created   jsonb := '[]'::jsonb;
  v_short     jsonb := '[]'::jsonb;
  v_number    text;
  v_complete  boolean;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_reserve');
  if v_previous is not null then return v_previous; end if;

  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'Materials can only be reserved for approved orders (order is %).', v_order.status using errcode = 'P0001';
  end if;

  for v_line in
    select m.*, p.sku, p.base_unit, p.status as product_status, p.archived_at
    from public.production_order_materials m join public.products p on p.id = m.component_product_id
    where m.production_order_id = v_order.id
    order by m.line_no
    for update of m
  loop
    v_need := v_line.planned_quantity - v_line.issued_quantity - private.order_open_reserved(v_order.id, v_line.component_product_id);
    continue when v_need <= 0;
    if v_line.unit <> v_line.base_unit then
      raise exception '%: BOM unit % differs from inventory unit %; materials cannot be reserved.', v_line.sku, v_line.unit, v_line.base_unit
        using errcode = 'P0001';
    end if;
    v_whole := private.is_whole_unit(v_line.unit);
    if v_whole and v_need <> trunc(v_need) then
      raise exception '%: the open requirement of % % is not a whole number (the order was planned before whole-piece rules). Cancel this order and create it again so the plan is recalculated in whole pieces.',
        v_line.sku, trim_scale(v_need), v_line.unit using errcode = 'P0001';
    end if;

    for v_bal in
      select b.id, b.batch_id, b.location_id, b.warehouse_id, b.on_hand, b.reserved
      from public.inventory_balances b
      join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
      join public.inventory_batches bt on bt.id = b.batch_id
      where b.company_id = v_company and b.product_id = v_line.component_product_id
        and b.warehouse_id = v_order.source_warehouse_id and b.on_hand - b.reserved > 0
        and (bt.expiry_date is null or bt.expiry_date >= v_today)
      order by bt.expiry_date nulls last, bt.created_at, b.location_id
      for update of b
    loop
      v_take := least(v_need, case when v_whole then floor(v_bal.on_hand - v_bal.reserved) else v_bal.on_hand - v_bal.reserved end);
      continue when v_take <= 0;
      update public.inventory_balances set reserved = reserved + v_take, updated_at = now() where id = v_bal.id;
      v_number := private.next_document_number(v_company, 'RES');
      insert into public.stock_reservations (company_id, reservation_number, product_id, batch_id, warehouse_id, location_id,
        quantity, reference_type, reference_number, reference_id, notes, reserved_by)
      values (v_company, v_number, v_line.component_product_id, v_bal.batch_id, v_bal.warehouse_id, v_bal.location_id, v_take,
        'PRODUCTION_ORDER', v_order.production_order_number, v_order.id, 'Material for ' || v_order.production_order_number, auth.uid());
      v_created := v_created || jsonb_build_object('reservation_number', v_number, 'sku', v_line.sku, 'quantity', v_take);
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;

    if v_need > 0 then
      v_short := v_short || jsonb_build_object('sku', v_line.sku, 'short', v_need, 'unit', v_line.unit);
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_partial, false) then
    raise exception 'Not enough usable stock to reserve: %. Nothing was reserved.',
      (select string_agg(format('%s short by %s %s', s ->> 'sku', trim_scale((s ->> 'short')::numeric), s ->> 'unit'), '; ') from jsonb_array_elements(v_short) s)
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_created) = 0 and jsonb_array_length(v_short) = 0 then
    raise exception 'All materials for this order are already reserved or issued.' using errcode = 'P0001';
  end if;

  v_complete := jsonb_array_length(v_short) = 0;
  if v_order.status = 'APPROVED' and v_complete then
    update public.production_orders set status = 'MATERIALS_RESERVED' where id = v_order.id;
  end if;
  perform private.log_production_event(v_company, v_order.id, 'MATERIALS_RESERVED', v_order.status,
    case when v_order.status = 'APPROVED' and v_complete then 'MATERIALS_RESERVED' else v_order.status end, null,
    jsonb_build_object('reservations', v_created, 'shortages', v_short));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'reservations', v_created, 'shortages', v_short, 'fully_reserved', v_complete,
    'status', (select status from public.production_orders where id = v_order.id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Server-side enforcement (triggers): no RPC can store a fractional
--    physical quantity of a whole-piece item.
--
-- guard_whole_quantities(product_column, quantity_column, ...):
--   INSERT: every listed quantity must be whole.
--   UPDATE: only quantities that CHANGE are checked, so historical rows can
--           still be reversed, released or cancelled; adding a whole quantity
--           to a historical fraction is refused (reconcile it first).
--   Rows without a product (service / charge lines) are not checked.
-- -----------------------------------------------------------------------------
create or replace function private.guard_whole_quantities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new     jsonb := to_jsonb(new);
  v_old     jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_product uuid := nullif(v_new ->> tg_argv[0], '')::uuid;
  v_unit    text;
  v_sku     text;
  v_col     text;
  v_val     numeric;
  i         int;
begin
  if v_product is null then
    return new;
  end if;
  select base_unit, sku into v_unit, v_sku from public.products where id = v_product;
  v_unit := coalesce(nullif(v_new ->> 'unit', ''), v_unit);
  if not private.is_whole_unit(v_unit) then
    return new;
  end if;
  for i in 1 .. tg_nargs - 1 loop
    v_col := tg_argv[i];
    v_val := (v_new ->> v_col)::numeric;
    continue when v_val is null or v_val = trunc(v_val);
    continue when tg_op = 'UPDATE' and (v_old ->> v_col)::numeric is not distinct from v_val;
    raise exception '%', format('%s%s: %s %s %s is not a whole number. %s is counted in whole pieces; enter a whole quantity.',
      case when v_new ? 'line_no' then 'Line ' || (v_new ->> 'line_no') || ': ' else '' end,
      coalesce(v_sku, 'Item'), replace(v_col, '_', ' '), trim_scale(v_val), v_unit, v_unit)
      using errcode = 'P0001';
  end loop;
  return new;
end;
$$;

revoke all on function private.guard_whole_quantities() from public, anon, authenticated;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('production_orders',               'insert or update', array['finished_product_id', 'planned_quantity', 'completed_quantity', 'rejected_quantity', 'scrap_quantity']),
      ('production_order_materials',      'insert or update', array['component_product_id', 'planned_quantity', 'issued_quantity']),
      ('production_material_consumption', 'insert',           array['component_product_id', 'actual_quantity', 'reserved_quantity_used']),
      ('production_output_receipts',      'insert',           array['product_id', 'good_quantity', 'rejected_quantity', 'scrap_quantity']),
      ('outsourcing_orders',              'insert or update', array['product_id', 'ordered_quantity', 'received_quantity', 'accepted_quantity', 'rejected_quantity']),
      ('outsourcing_order_materials',     'insert or update', array['component_product_id', 'planned_quantity', 'dispatched_quantity', 'returned_quantity', 'consumed_quantity']),
      ('outsourcing_receipts',            'insert',           array['product_id', 'received_quantity', 'accepted_quantity', 'rejected_quantity']),
      ('outsourcing_material_movements',  'insert',           array['component_product_id', 'quantity']),
      ('stock_reservations',              'insert',           array['product_id', 'quantity']),
      ('inventory_adjustments',           'insert or update', array['product_id', 'counted_quantity', 'correction_quantity']),
      ('inventory_count_lines',           'insert or update', array['product_id', 'counted_quantity']),
      ('purchase_order_lines',            'insert or update', array['product_id', 'ordered_quantity']),
      ('goods_receipt_lines',             'insert',           array['product_id', 'received_quantity', 'accepted_quantity', 'rejected_quantity'])
    ) v(tbl, events, args)
  loop
    if to_regclass('public.' || t.tbl) is null then
      continue;
    end if;
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_whole_pieces', t.tbl);
    execute format('create trigger %I before %s on public.%I for each row execute function private.guard_whole_quantities(%s)',
      t.tbl || '_whole_pieces', t.events, t.tbl, (select string_agg(quote_literal(a), ', ') from unnest(t.args) a));
  end loop;
end;
$$;

-- The stock ledger itself (every module posts through it).
--   Allowed fractional postings of a whole-piece item, both only REMOVE a
--   historical fraction and never create one:
--     * the exact reversal of an earlier posting;
--     * an approved stock adjustment / count that leaves the balance whole.
create or replace function private.guard_whole_ledger_quantity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_on_hand numeric;
  v_sku     text;
begin
  if not private.is_whole_unit(new.unit) or new.quantity = trunc(new.quantity) then
    return new;
  end if;
  if new.transaction_type = 'REVERSAL'
     and exists (select 1 from public.inventory_transactions o where o.id = new.reversal_of_transaction_id and o.quantity = new.quantity) then
    return new;
  end if;
  if new.transaction_type in ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') and new.document_type in ('ADJUSTMENT', 'COUNT') then
    -- post_movement updates the balance before inserting the ledger row.
    select on_hand into v_on_hand from public.inventory_balances where batch_id = new.batch_id and location_id = new.location_id;
    if v_on_hand is not null and v_on_hand = trunc(v_on_hand) then
      return new;
    end if;
  end if;
  select sku into v_sku from public.products where id = new.product_id;
  raise exception '%: % % is not a whole number. % stock moves in whole pieces only.', coalesce(v_sku, 'Item'), trim_scale(new.quantity), new.unit, new.unit
    using errcode = 'P0001';
end;
$$;

revoke all on function private.guard_whole_ledger_quantity() from public, anon, authenticated;

drop trigger if exists inventory_transactions_whole_pieces on public.inventory_transactions;
create trigger inventory_transactions_whole_pieces before insert on public.inventory_transactions
  for each row execute function private.guard_whole_ledger_quantity();

-- BOMs: whole pieces per BOM batch when submitted or approved (drafts may hold
-- a fraction while being corrected; a new version copies the old lines).
create or replace function private.guard_bom_whole_quantities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bad record;
begin
  if new.status not in ('PENDING_APPROVAL', 'APPROVED') or new.status is not distinct from old.status then
    return new;
  end if;
  if private.is_whole_unit(new.output_unit) and new.output_quantity <> trunc(new.output_quantity) then
    raise exception 'The BOM output quantity % % is not a whole number. % is counted in whole pieces.',
      trim_scale(new.output_quantity), new.output_unit, new.output_unit using errcode = 'P0001';
  end if;
  select bi.line_no, p.sku, bi.quantity_required, bi.unit into v_bad
  from public.bom_items bi join public.products p on p.id = bi.component_product_id
  where bi.bom_id = new.id and private.is_whole_unit(bi.unit) and bi.quantity_required <> trunc(bi.quantity_required)
  order by bi.line_no limit 1;
  if found then
    raise exception 'Line %: % quantity % % is not a whole number. Enter whole pieces per BOM batch: for 1 piece per 2 finished units, set the component quantity to 1 and the output quantity to 2.',
      v_bad.line_no, v_bad.sku, trim_scale(v_bad.quantity_required), v_bad.unit using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_bom_whole_quantities() from public, anon, authenticated;

drop trigger if exists boms_whole_pieces on public.boms;
create trigger boms_whole_pieces before update on public.boms
  for each row execute function private.guard_bom_whole_quantities();

-- -----------------------------------------------------------------------------
-- 4. Read-only audit of existing fractional data (never modifies anything)
--
-- classification:
--   NEEDS_CORRECTION   BOM data that cannot be submitted/approved as it is
--   THEORETICAL_RATIO  valid BOM ratio (e.g. 2 per 70 units); planning rounds up
--   INVALID_PLAN       fractional planned / ordered quantity of a document
--   INVALID_PHYSICAL   fractional physical stock, movement or posted quantity
--   REVERSED_HISTORY   fractional posting that has since been reversed
--   ADJUSTMENT_HISTORY fractional approved adjustment / count posting (e.g. the
--                      reconciliation that removed a fraction); history only
--
-- The query between AUDIT-QUERY-BEGIN and AUDIT-QUERY-CORE-END is copied (with
-- the unit list inlined) into supabase/audit/whole_piece_quantity_audit.sql so
-- it can be run BEFORE this migration; tests/unit/whole-units.test.ts keeps the
-- two in sync (regenerate with: node scripts/generate-whole-unit-audit.mjs).
-- -----------------------------------------------------------------------------
create or replace function private.whole_unit_findings(p_company uuid)
returns table (
  company_id uuid, category text, classification text, reference text, record_id uuid, link text,
  sku text, unit text, field text, value numeric, detail text
)
language sql
stable
security definer
set search_path = ''
as $$
-- AUDIT-QUERY-BEGIN
  select b.company_id, 'BOM_LINE'::text,
    case when bi.quantity_required <> trunc(bi.quantity_required) then 'NEEDS_CORRECTION' else 'THEORETICAL_RATIO' end,
    b.bom_code || ' v' || b.version || ' line ' || bi.line_no, b.id, '/production/boms/' || b.id,
    p.sku, bi.unit, 'quantity_required'::text, bi.quantity_required,
    format('%s %s per %s %s of %s = %s per finished unit (BOM %s)', trim_scale(bi.quantity_required), bi.unit,
      trim_scale(b.output_quantity), b.output_unit, fp.sku, trim_scale(round(bi.quantity_required / b.output_quantity, 6)), lower(b.status))
  from public.boms b
  join public.bom_items bi on bi.bom_id = b.id
  join public.products p on p.id = bi.component_product_id
  join public.products fp on fp.id = b.finished_product_id
  where (p_company is null or b.company_id = p_company) and b.status <> 'ARCHIVED'
    and upper(btrim(bi.unit)) = any(private.whole_unit_codes())
    and (bi.quantity_required <> trunc(bi.quantity_required)
         or bi.quantity_required / b.output_quantity <> trunc(bi.quantity_required / b.output_quantity))
  union all
  select b.company_id, 'BOM_OUTPUT', 'NEEDS_CORRECTION', b.bom_code || ' v' || b.version, b.id, '/production/boms/' || b.id,
    fp.sku, b.output_unit, 'output_quantity', b.output_quantity, format('BOM %s', lower(b.status))
  from public.boms b join public.products fp on fp.id = b.finished_product_id
  where (p_company is null or b.company_id = p_company) and b.status <> 'ARCHIVED'
    and upper(btrim(b.output_unit)) = any(private.whole_unit_codes()) and b.output_quantity <> trunc(b.output_quantity)
  union all
  select bl.company_id, 'STOCK_BALANCE', 'INVALID_PHYSICAL',
    p.sku || ' @ ' || w.warehouse_code || '/' || l.location_code || coalesce(' / ' || bt.batch_number, ''), bl.id, '/inventory/stock/' || p.id,
    p.sku, p.base_unit, case when bl.on_hand <> trunc(bl.on_hand) then 'on_hand' else 'reserved' end,
    case when bl.on_hand <> trunc(bl.on_hand) then bl.on_hand else bl.reserved end,
    format('On hand %s, reserved %s, available %s %s (source %s)', trim_scale(bl.on_hand), trim_scale(bl.reserved),
      trim_scale(bl.on_hand - bl.reserved), p.base_unit, bl.source_type)
  from public.inventory_balances bl
  join public.products p on p.id = bl.product_id
  join public.warehouses w on w.id = bl.warehouse_id
  join public.inventory_locations l on l.id = bl.location_id
  join public.inventory_batches bt on bt.id = bl.batch_id
  where (p_company is null or bl.company_id = p_company)
    and upper(btrim(p.base_unit)) = any(private.whole_unit_codes())
    and (bl.on_hand <> trunc(bl.on_hand) or bl.reserved <> trunc(bl.reserved))
  union all
  select t.company_id, 'LEDGER_ENTRY',
    case when t.transaction_type = 'REVERSAL' or exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = t.id)
           then 'REVERSED_HISTORY'
         when t.transaction_type in ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') and t.document_type in ('ADJUSTMENT', 'COUNT')
           then 'ADJUSTMENT_HISTORY'
         else 'INVALID_PHYSICAL' end,
    t.transaction_number, t.id, '/inventory/stock/' || t.product_id,
    p.sku, t.unit, 'quantity', t.quantity,
    format('%s %s %s on %s%s', t.transaction_type, case when t.direction = 1 then '+' else '-' end || trim_scale(t.quantity), t.unit,
      to_char(t.transaction_date, 'YYYY-MM-DD'), coalesce(' for ' || t.reference_type || ' ' || t.reference_number, ''))
  from public.inventory_transactions t join public.products p on p.id = t.product_id
  where (p_company is null or t.company_id = p_company)
    and upper(btrim(t.unit)) = any(private.whole_unit_codes()) and t.quantity <> trunc(t.quantity)
  union all
  select r.company_id, 'RESERVATION', 'INVALID_PHYSICAL', r.reservation_number, r.id, '/inventory/stock/' || r.product_id,
    p.sku, p.base_unit, 'open_quantity', r.quantity - r.fulfilled_quantity - r.released_quantity,
    format('Open reservation for %s %s (%s)', r.reference_type, r.reference_number, lower(r.reservation_status))
  from public.stock_reservations r join public.products p on p.id = r.product_id
  where (p_company is null or r.company_id = p_company) and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    and upper(btrim(p.base_unit)) = any(private.whole_unit_codes())
    and (r.quantity - r.fulfilled_quantity - r.released_quantity) <> trunc(r.quantity - r.fulfilled_quantity - r.released_quantity)
  union all
  select o.company_id, 'PRODUCTION_ORDER', case when f.field = 'planned_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.production_order_number, o.id, '/production/orders/' || o.id, p.sku, o.unit, f.field, f.value, format('Order %s', lower(o.status))
  from public.production_orders o join public.products p on p.id = o.finished_product_id
  cross join lateral (values ('planned_quantity', o.planned_quantity), ('completed_quantity', o.completed_quantity),
    ('rejected_quantity', o.rejected_quantity), ('scrap_quantity', o.scrap_quantity)) f(field, value)
  where (p_company is null or o.company_id = p_company)
    and upper(btrim(o.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
  union all
  select m.company_id, 'PRODUCTION_MATERIAL', case when f.field = 'planned_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.production_order_number || ' line ' || m.line_no, o.id, '/production/orders/' || o.id, p.sku, m.unit, f.field, f.value,
    format('Order %s', lower(o.status))
  from public.production_order_materials m
  join public.production_orders o on o.id = m.production_order_id
  join public.products p on p.id = m.component_product_id
  cross join lateral (values ('planned_quantity', m.planned_quantity), ('issued_quantity', m.issued_quantity)) f(field, value)
  where (p_company is null or m.company_id = p_company)
    and upper(btrim(m.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
  union all
  select c.company_id, 'PRODUCTION_ISSUE', case when c.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    o.production_order_number || ' / ' || coalesce(t.transaction_number, '?'), o.id, '/production/orders/' || o.id,
    p.sku, c.unit, 'actual_quantity', c.actual_quantity, format('Issued on %s (%s)', c.consumption_date, lower(c.status))
  from public.production_material_consumption c
  join public.production_orders o on o.id = c.production_order_id
  join public.products p on p.id = c.component_product_id
  left join public.inventory_transactions t on t.id = c.inventory_transaction_id
  where (p_company is null or c.company_id = p_company)
    and upper(btrim(c.unit)) = any(private.whole_unit_codes()) and c.actual_quantity <> trunc(c.actual_quantity)
  union all
  select r.company_id, 'PRODUCTION_OUTPUT', case when r.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    r.receipt_number, o.id, '/production/orders/' || o.id, p.sku, r.unit, f.field, f.value,
    format('Output of %s on %s (%s)', o.production_order_number, r.production_date, lower(r.status))
  from public.production_output_receipts r
  join public.production_orders o on o.id = r.production_order_id
  join public.products p on p.id = r.product_id
  cross join lateral (values ('good_quantity', r.good_quantity), ('rejected_quantity', r.rejected_quantity), ('scrap_quantity', r.scrap_quantity)) f(field, value)
  where (p_company is null or r.company_id = p_company)
    and upper(btrim(r.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
  union all
  select o.company_id, 'OUTSOURCING_ORDER', case when f.field = 'ordered_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.outsourcing_order_number, o.id, '/production/outsourcing/' || o.id, p.sku, o.unit, f.field, f.value, format('Order %s', lower(o.status))
  from public.outsourcing_orders o join public.products p on p.id = o.product_id
  cross join lateral (values ('ordered_quantity', o.ordered_quantity), ('received_quantity', o.received_quantity),
    ('accepted_quantity', o.accepted_quantity), ('rejected_quantity', o.rejected_quantity)) f(field, value)
  where (p_company is null or o.company_id = p_company)
    and upper(btrim(o.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
  union all
  select m.company_id, 'OUTSOURCING_MATERIAL', case when f.field = 'planned_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.outsourcing_order_number || ' line ' || m.line_no, o.id, '/production/outsourcing/' || o.id, p.sku, m.unit, f.field, f.value,
    format('Order %s', lower(o.status))
  from public.outsourcing_order_materials m
  join public.outsourcing_orders o on o.id = m.outsourcing_order_id
  join public.products p on p.id = m.component_product_id
  cross join lateral (values ('planned_quantity', m.planned_quantity), ('dispatched_quantity', m.dispatched_quantity),
    ('returned_quantity', m.returned_quantity), ('consumed_quantity', m.consumed_quantity)) f(field, value)
  where (p_company is null or m.company_id = p_company)
    and upper(btrim(m.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
  union all
  select r.company_id, 'OUTSOURCING_RECEIPT', case when r.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    r.receipt_number, o.id, '/production/outsourcing/' || o.id, p.sku, r.unit, f.field, f.value,
    format('Receipt for %s on %s (%s)', o.outsourcing_order_number, r.receipt_date, lower(r.status))
  from public.outsourcing_receipts r
  join public.outsourcing_orders o on o.id = r.outsourcing_order_id
  join public.products p on p.id = r.product_id
  cross join lateral (values ('received_quantity', r.received_quantity), ('accepted_quantity', r.accepted_quantity),
    ('rejected_quantity', r.rejected_quantity)) f(field, value)
  where (p_company is null or r.company_id = p_company)
    and upper(btrim(r.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
  union all
  select mv.company_id, 'OUTSOURCING_MOVEMENT', case when mv.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    o.outsourcing_order_number || ' ' || lower(mv.movement_type), o.id, '/production/outsourcing/' || o.id,
    p.sku, mv.unit, 'quantity', mv.quantity, format('%s on %s (%s)', initcap(mv.movement_type), mv.movement_date, lower(mv.status))
  from public.outsourcing_material_movements mv
  join public.outsourcing_orders o on o.id = mv.outsourcing_order_id
  join public.products p on p.id = mv.component_product_id
  where (p_company is null or mv.company_id = p_company)
    and upper(btrim(mv.unit)) = any(private.whole_unit_codes()) and mv.quantity <> trunc(mv.quantity)
-- AUDIT-QUERY-CORE-END (purchasing tables below may not exist before the purchase order migrations)
  union all
  select l.company_id, 'PURCHASE_ORDER_LINE', 'INVALID_PLAN', po.po_number || ' line ' || l.line_no, po.id, '/purchase-orders/' || po.id,
    p.sku, l.unit, 'ordered_quantity', l.ordered_quantity, format('Purchase order %s', lower(po.status))
  from public.purchase_order_lines l
  join public.purchase_orders po on po.id = l.purchase_order_id
  join public.products p on p.id = l.product_id
  where (p_company is null or l.company_id = p_company)
    and upper(btrim(l.unit)) = any(private.whole_unit_codes()) and l.ordered_quantity <> trunc(l.ordered_quantity)
  union all
  select gl.company_id, 'GOODS_RECEIPT_LINE', case when g.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end, g.receipt_number, g.purchase_order_id, '/purchase-orders/' || g.purchase_order_id,
    p.sku, gl.unit, f.field, f.value, format('Goods receipt %s', lower(g.status))
  from public.goods_receipt_lines gl
  join public.goods_receipts g on g.id = gl.goods_receipt_id
  join public.products p on p.id = gl.product_id
  cross join lateral (values ('received_quantity', gl.received_quantity), ('accepted_quantity', gl.accepted_quantity),
    ('rejected_quantity', gl.rejected_quantity)) f(field, value)
  where (p_company is null or gl.company_id = p_company)
    and upper(btrim(gl.unit)) = any(private.whole_unit_codes()) and f.value <> trunc(f.value)
-- AUDIT-QUERY-END
$$;

revoke all on function private.whole_unit_findings(uuid) from public, anon, authenticated;

-- In-app report for the caller's company. Read only.
create or replace function public.whole_unit_quantity_audit()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['inventory_reconciliation.run', 'audit_logs.read']);
begin
  return (
    with f as (select * from private.whole_unit_findings(v_company))
    select jsonb_build_object(
      'generated_at', now(),
      'whole_units', to_jsonb(private.whole_unit_codes()),
      'total', (select count(*) from f),
      'summary', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'classification', classification, 'count', n)
                                            order by category, classification)
                           from (select category, classification, count(*) n from f group by 1, 2) s), '[]'::jsonb),
      'findings', coalesce((select jsonb_agg(to_jsonb(x) - 'company_id' order by x.category, x.reference, x.field)
                            from (select * from f order by category, reference, field limit 2000) x), '[]'::jsonb),
      'truncated', (select count(*) > 2000 from f)
    )
  );
end;
$$;

revoke all on function public.whole_unit_quantity_audit() from public, anon;
grant execute on function public.whole_unit_quantity_audit() to authenticated;

comment on function public.whole_unit_quantity_audit() is
  'Read-only list of fractional quantities of whole-piece items (BOMs, stock, ledger, reservations, production, outsourcing, purchasing). Changes nothing.';
