-- =============================================================================
-- WHOLE-PIECE QUANTITY AUDIT (READ ONLY)
--
-- Lists every fractional quantity of a whole-piece item (PCS, NOS, SET, PAIR
-- and aliases) in BOMs, stock balances, the stock ledger, open reservations,
-- production orders and outsourcing orders, for every company.
--
-- It only SELECTs. It does not change, round, delete or reverse anything and
-- can be run on production before or after the whole-piece migration
-- (Supabase Dashboard > SQL Editor > paste > Run; export the result as CSV).
--
-- classification:
--   NEEDS_CORRECTION   BOM quantity that cannot be submitted / approved as is
--   THEORETICAL_RATIO  valid BOM ratio (e.g. 2 per 70 units); planning rounds up
--   INVALID_PLAN       fractional planned / ordered quantity on a document
--   INVALID_PHYSICAL   fractional physical stock, movement or posted quantity
--   REVERSED_HISTORY   fractional posting that has already been reversed
--   ADJUSTMENT_HISTORY fractional approved adjustment / count posting (history)
--
-- Records that need action: STOCK_BALANCE, RESERVATION, INVALID_PLAN rows on
-- open documents, and NEEDS_CORRECTION BOMs. Ledger rows show where each
-- fraction came from; they are history and are never edited.
--
-- Purchase order lines and goods receipts are included in the in-app audit
-- (Inventory > Whole-piece audit) once the purchase order migrations exist.
--
-- GENERATED from supabase/migrations/20261029090000_whole_piece_quantities.sql
-- by scripts/generate-whole-unit-audit.mjs. Do not edit by hand.
-- =============================================================================

select c.company_code, f.category, f.classification, f.reference, f.sku, f.unit, f.field, f.value, f.detail, f.record_id, f.link
from (
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
  where (null::uuid is null or b.company_id = null::uuid) and b.status <> 'ARCHIVED'
    and upper(btrim(bi.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[])
    and (bi.quantity_required <> trunc(bi.quantity_required)
         or bi.quantity_required / b.output_quantity <> trunc(bi.quantity_required / b.output_quantity))
  union all
  select b.company_id, 'BOM_OUTPUT', 'NEEDS_CORRECTION', b.bom_code || ' v' || b.version, b.id, '/production/boms/' || b.id,
    fp.sku, b.output_unit, 'output_quantity', b.output_quantity, format('BOM %s', lower(b.status))
  from public.boms b join public.products fp on fp.id = b.finished_product_id
  where (null::uuid is null or b.company_id = null::uuid) and b.status <> 'ARCHIVED'
    and upper(btrim(b.output_unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and b.output_quantity <> trunc(b.output_quantity)
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
  where (null::uuid is null or bl.company_id = null::uuid)
    and upper(btrim(p.base_unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[])
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
  where (null::uuid is null or t.company_id = null::uuid)
    and upper(btrim(t.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and t.quantity <> trunc(t.quantity)
  union all
  select r.company_id, 'RESERVATION', 'INVALID_PHYSICAL', r.reservation_number, r.id, '/inventory/stock/' || r.product_id,
    p.sku, p.base_unit, 'open_quantity', r.quantity - r.fulfilled_quantity - r.released_quantity,
    format('Open reservation for %s %s (%s)', r.reference_type, r.reference_number, lower(r.reservation_status))
  from public.stock_reservations r join public.products p on p.id = r.product_id
  where (null::uuid is null or r.company_id = null::uuid) and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    and upper(btrim(p.base_unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[])
    and (r.quantity - r.fulfilled_quantity - r.released_quantity) <> trunc(r.quantity - r.fulfilled_quantity - r.released_quantity)
  union all
  select o.company_id, 'PRODUCTION_ORDER', case when f.field = 'planned_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.production_order_number, o.id, '/production/orders/' || o.id, p.sku, o.unit, f.field, f.value, format('Order %s', lower(o.status))
  from public.production_orders o join public.products p on p.id = o.finished_product_id
  cross join lateral (values ('planned_quantity', o.planned_quantity), ('completed_quantity', o.completed_quantity),
    ('rejected_quantity', o.rejected_quantity), ('scrap_quantity', o.scrap_quantity)) f(field, value)
  where (null::uuid is null or o.company_id = null::uuid)
    and upper(btrim(o.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and f.value <> trunc(f.value)
  union all
  select m.company_id, 'PRODUCTION_MATERIAL', case when f.field = 'planned_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.production_order_number || ' line ' || m.line_no, o.id, '/production/orders/' || o.id, p.sku, m.unit, f.field, f.value,
    format('Order %s', lower(o.status))
  from public.production_order_materials m
  join public.production_orders o on o.id = m.production_order_id
  join public.products p on p.id = m.component_product_id
  cross join lateral (values ('planned_quantity', m.planned_quantity), ('issued_quantity', m.issued_quantity)) f(field, value)
  where (null::uuid is null or m.company_id = null::uuid)
    and upper(btrim(m.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and f.value <> trunc(f.value)
  union all
  select c.company_id, 'PRODUCTION_ISSUE', case when c.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    o.production_order_number || ' / ' || coalesce(t.transaction_number, '?'), o.id, '/production/orders/' || o.id,
    p.sku, c.unit, 'actual_quantity', c.actual_quantity, format('Issued on %s (%s)', c.consumption_date, lower(c.status))
  from public.production_material_consumption c
  join public.production_orders o on o.id = c.production_order_id
  join public.products p on p.id = c.component_product_id
  left join public.inventory_transactions t on t.id = c.inventory_transaction_id
  where (null::uuid is null or c.company_id = null::uuid)
    and upper(btrim(c.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and c.actual_quantity <> trunc(c.actual_quantity)
  union all
  select r.company_id, 'PRODUCTION_OUTPUT', case when r.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    r.receipt_number, o.id, '/production/orders/' || o.id, p.sku, r.unit, f.field, f.value,
    format('Output of %s on %s (%s)', o.production_order_number, r.production_date, lower(r.status))
  from public.production_output_receipts r
  join public.production_orders o on o.id = r.production_order_id
  join public.products p on p.id = r.product_id
  cross join lateral (values ('good_quantity', r.good_quantity), ('rejected_quantity', r.rejected_quantity), ('scrap_quantity', r.scrap_quantity)) f(field, value)
  where (null::uuid is null or r.company_id = null::uuid)
    and upper(btrim(r.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and f.value <> trunc(f.value)
  union all
  select o.company_id, 'OUTSOURCING_ORDER', case when f.field = 'ordered_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.outsourcing_order_number, o.id, '/production/outsourcing/' || o.id, p.sku, o.unit, f.field, f.value, format('Order %s', lower(o.status))
  from public.outsourcing_orders o join public.products p on p.id = o.product_id
  cross join lateral (values ('ordered_quantity', o.ordered_quantity), ('received_quantity', o.received_quantity),
    ('accepted_quantity', o.accepted_quantity), ('rejected_quantity', o.rejected_quantity)) f(field, value)
  where (null::uuid is null or o.company_id = null::uuid)
    and upper(btrim(o.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and f.value <> trunc(f.value)
  union all
  select m.company_id, 'OUTSOURCING_MATERIAL', case when f.field = 'planned_quantity' then 'INVALID_PLAN' else 'INVALID_PHYSICAL' end,
    o.outsourcing_order_number || ' line ' || m.line_no, o.id, '/production/outsourcing/' || o.id, p.sku, m.unit, f.field, f.value,
    format('Order %s', lower(o.status))
  from public.outsourcing_order_materials m
  join public.outsourcing_orders o on o.id = m.outsourcing_order_id
  join public.products p on p.id = m.component_product_id
  cross join lateral (values ('planned_quantity', m.planned_quantity), ('dispatched_quantity', m.dispatched_quantity),
    ('returned_quantity', m.returned_quantity), ('consumed_quantity', m.consumed_quantity)) f(field, value)
  where (null::uuid is null or m.company_id = null::uuid)
    and upper(btrim(m.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and f.value <> trunc(f.value)
  union all
  select r.company_id, 'OUTSOURCING_RECEIPT', case when r.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    r.receipt_number, o.id, '/production/outsourcing/' || o.id, p.sku, r.unit, f.field, f.value,
    format('Receipt for %s on %s (%s)', o.outsourcing_order_number, r.receipt_date, lower(r.status))
  from public.outsourcing_receipts r
  join public.outsourcing_orders o on o.id = r.outsourcing_order_id
  join public.products p on p.id = r.product_id
  cross join lateral (values ('received_quantity', r.received_quantity), ('accepted_quantity', r.accepted_quantity),
    ('rejected_quantity', r.rejected_quantity)) f(field, value)
  where (null::uuid is null or r.company_id = null::uuid)
    and upper(btrim(r.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and f.value <> trunc(f.value)
  union all
  select mv.company_id, 'OUTSOURCING_MOVEMENT', case when mv.status = 'REVERSED' then 'REVERSED_HISTORY' else 'INVALID_PHYSICAL' end,
    o.outsourcing_order_number || ' ' || lower(mv.movement_type), o.id, '/production/outsourcing/' || o.id,
    p.sku, mv.unit, 'quantity', mv.quantity, format('%s on %s (%s)', initcap(mv.movement_type), mv.movement_date, lower(mv.status))
  from public.outsourcing_material_movements mv
  join public.outsourcing_orders o on o.id = mv.outsourcing_order_id
  join public.products p on p.id = mv.component_product_id
  where (null::uuid is null or mv.company_id = null::uuid)
    and upper(btrim(mv.unit)) = any(array['PCS', 'PC', 'PIECE', 'PIECES', 'NOS', 'NO', 'NUMBER', 'NUMBERS', 'EA', 'EACH', 'UNIT', 'UNITS', 'SET', 'SETS', 'PAIR', 'PAIRS', 'PR']::text[]) and mv.quantity <> trunc(mv.quantity)
) f (company_id, category, classification, reference, record_id, link, sku, unit, field, value, detail)
join public.companies c on c.id = f.company_id
order by c.company_code, f.category, f.reference, f.field;
