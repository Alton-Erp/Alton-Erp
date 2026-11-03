import type { ExistingBom } from '@/features/production/bom-import'
import { requireSupabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import type { BatchRow, ReservationRow, StockDetailRow } from '@/types/database-inventory'
import type {
  BomItemListRow,
  BomListRow,
  BomStatus,
  ConsumptionListRow,
  OutputListRow,
  OutsourcingEventRow,
  OutsourcingMaterialListRow,
  OutsourcingMovementListRow,
  OutsourcingOrderListRow,
  OutsourcingReceiptListRow,
  OutsourcingStatus,
  OutsourcingType,
  ProductionEventRow,
  ProductionOrderListRow,
  ProductionPriority,
  ProductionStatus,
  QualityStatus,
  RejectionDisposition,
} from '@/types/database-production'

/**
 * Manufacturing & outsourcing data access. Reads go through RLS-protected
 * tables / security-invoker views; every change goes through a SECURITY
 * DEFINER RPC that checks permissions, validates status transitions, locks
 * rows and posts stock only through the Phase 4 ledger. Stock-changing calls
 * carry an idempotency key (one per user action, reused on retry).
 */

const db = () => requireSupabase()

async function rpc<T = Json>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// BOMs
// ---------------------------------------------------------------------------
export async function fetchBoms(status: BomStatus | 'ACTIVE' | null): Promise<BomListRow[]> {
  let query = db().from('bom_list_v2').select('*').order('bom_code').order('version', { ascending: false }).limit(2000)
  if (status === 'ACTIVE') query = query.neq('status', 'ARCHIVED')
  else if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

/** Approved BOM versions effective on `today` (selectable for new orders). */
export async function fetchEffectiveBoms(today: string, productId?: string | null): Promise<BomListRow[]> {
  let query = db()
    .from('bom_list')
    .select('*')
    .eq('status', 'APPROVED')
    .lte('effective_from', today)
    .or(`effective_to.is.null,effective_to.gte.${today}`)
    .order('sku')
  if (productId) query = query.eq('finished_product_id', productId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function fetchBom(id: string): Promise<{ bom: BomListRow; items: BomItemListRow[]; versions: BomListRow[] }> {
  const { data: bom, error } = await db().from('bom_list_v2').select('*').eq('id', id).single()
  if (error) throw error
  const [items, versions] = await Promise.all([
    db().from('bom_item_list').select('*').eq('bom_id', id).order('line_no'),
    db().from('bom_list_v2').select('*').eq('finished_product_id', bom.finished_product_id).order('version', { ascending: false }),
  ])
  if (items.error) throw items.error
  if (versions.error) throw versions.error
  return { bom, items: items.data ?? [], versions: versions.data ?? [] }
}

/**
 * Products by SKU (case-insensitive) for the BOM import, with their planning fields, current
 * active BOM version and latest non-archived BOM (with its components, to avoid duplicates).
 */
export async function fetchBomImportLookups(skus: string[]) {
  const products = new Map<string, {
    id: string; sku: string; product_name: string; product_type: string; base_unit: string; status: string; archived: boolean
    gst_rate: number | null; lead_time_days: number | null; group_head: string | null; minimum_cover_days: number | null
  }>()
  const ids: string[] = []
  for (let i = 0; i < skus.length; i += 500) {
    const { data, error } = await requireSupabase().rpc('check_product_identifiers', { p_skus: skus.slice(i, i + 500), p_barcodes: [] })
    if (error) throw error
    ids.push(...(data ?? []).filter((r) => r.kind === 'sku').map((r) => r.product_id))
  }
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await requireSupabase().from('products')
      .select('id, sku, product_name, product_type, base_unit, status, archived_at, gst_rate, lead_time_days, group_head, minimum_cover_days').in('id', ids.slice(i, i + 200))
    if (error) throw error
    for (const p of data ?? []) products.set(p.sku.trim().toLowerCase(), { ...p, archived: p.archived_at !== null })
  }
  const activeVersions = new Map<string, number>()
  const latestBoms = new Map<string, ExistingBom>()
  if (ids.length > 0) {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db().from('bom_list').select('id, bom_code, finished_product_id, version, status, output_quantity')
        .neq('status', 'ARCHIVED').in('finished_product_id', ids.slice(i, i + 200))
      if (error) throw error
      for (const b of data ?? []) {
        if (b.status === 'APPROVED') activeVersions.set(b.finished_product_id, Math.max(activeVersions.get(b.finished_product_id) ?? 0, b.version))
        const cur = latestBoms.get(b.finished_product_id)
        if (!cur || b.version > cur.version) {
          latestBoms.set(b.finished_product_id, { id: b.id, bom_code: b.bom_code, version: b.version, status: b.status, output_quantity: Number(b.output_quantity), items: [] })
        }
      }
    }
    const bomIds = [...latestBoms.values()].map((b) => b.id)
    const byBom = new Map([...latestBoms.values()].map((b) => [b.id, b]))
    for (let i = 0; i < bomIds.length; i += 200) {
      const { data, error } = await db().from('bom_item_list')
        .select('bom_id, component_product_id, quantity_required, unit, wastage_percentage, source_type, preferred_supplier_id, notes').in('bom_id', bomIds.slice(i, i + 200))
      if (error) throw error
      for (const it of (data ?? []) as { bom_id: string; component_product_id: string; quantity_required: number; unit: string; wastage_percentage: number; source_type: string | null; preferred_supplier_id: string | null; notes: string | null }[]) {
        byBom.get(it.bom_id)?.items.push({ ...it, quantity_required: Number(it.quantity_required), wastage_percentage: Number(it.wastage_percentage) })
      }
    }
  }
  return { products, activeVersions, latestBoms }
}

/** Components of these BOM versions (for the BOM Excel export). */
export async function fetchBomItemsFor(bomIds: string[]): Promise<BomItemListRow[]> {
  const out: BomItemListRow[] = []
  for (let i = 0; i < bomIds.length; i += 200) {
    const { data, error } = await db().from('bom_item_list').select('*').in('bom_id', bomIds.slice(i, i + 200)).order('line_no')
    if (error) throw error
    out.push(...(data ?? []))
  }
  return out
}

/** BOM versions of a product, and the (non-archived) BOMs that use it as a component. */
export async function fetchProductBomSummary(productId: string): Promise<{ versions: BomListRow[]; usedIn: (BomListRow & { quantity_required: number; unit: string })[] }> {
  const [versions, items] = await Promise.all([
    db().from('bom_list').select('*').eq('finished_product_id', productId).order('version', { ascending: false }),
    db().from('bom_item_list').select('bom_id, quantity_required, unit').eq('component_product_id', productId).limit(500),
  ])
  if (versions.error) throw versions.error
  if (items.error) throw items.error
  const byBom = new Map((items.data ?? []).map((i) => [i.bom_id, i]))
  let usedIn: (BomListRow & { quantity_required: number; unit: string })[] = []
  if (byBom.size > 0) {
    const { data, error } = await db().from('bom_list').select('*').in('id', [...byBom.keys()]).neq('status', 'ARCHIVED').order('sku')
    if (error) throw error
    usedIn = (data ?? []).map((b) => ({ ...b, quantity_required: Number(byBom.get(b.id)!.quantity_required), unit: byBom.get(b.id)!.unit }))
  }
  return { versions: versions.data ?? [], usedIn }
}

export interface BomItemInput {
  component_product_id: string
  quantity_required: number
  unit: string
  wastage_percentage: number
  notes: string | null
  /** IN_HOUSE / OUTSOURCED / PURCHASED; null = default from the component's product master. */
  source_type?: string | null
  /** null = the component's preferred supplier. */
  preferred_supplier_id?: string | null
}

export const saveBom = (
  input: {
    bomId: string | null
    finishedProductId: string
    effectiveFrom: string
    effectiveTo: string | null
    outputQuantity: number
    notes: string | null
    items: BomItemInput[]
  },
  key: string,
) =>
  rpc<{ bom_id: string; bom_code: string; version: number }>('production_save_bom', {
    p_bom_id: input.bomId,
    p_finished_product_id: input.finishedProductId,
    p_effective_from: input.effectiveFrom,
    p_effective_to: input.effectiveTo,
    p_output_quantity: input.outputQuantity,
    p_notes: input.notes,
    p_items: input.items,
    p_idempotency_key: key,
  })

export const newBomVersion = (sourceBomId: string, key: string) =>
  rpc<{ bom_id: string; bom_code: string; version: number }>('production_new_bom_version', { p_source_bom_id: sourceBomId, p_idempotency_key: key })

export type BomAction = 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'ARCHIVE'
export const bomAction = (bomId: string, action: BomAction, note: string | null) =>
  rpc<{ status: BomStatus; closed_versions: string[] }>('production_bom_action', { p_bom_id: bomId, p_action: action, p_note: note })

/** V2 single-operator: submit + approve in one step, making the BOM the active version. */
export const activateBom = (bomId: string, note: string | null) =>
  rpc<{ status: BomStatus; closed_versions: string[]; superseded_versions?: string[] }>('production_bom_activate', { p_bom_id: bomId, p_note: note })

export type RequirementStatus ='SUFFICIENT' | 'PARTIAL' | 'SHORTAGE' | 'INACTIVE' | 'UNIT_MISMATCH'
export interface RequirementLine {
  line_no: number
  component_product_id: string
  sku: string
  product_name: string
  product_type: string
  unit: string
  inventory_unit: string
  quantity_per_unit: number
  wastage_percentage: number
  base_requirement: number
  wastage_allowance: number
  total_requirement: number
  on_hand: number
  reserved: number
  available: number | null
  shortage: number | null
  suggested_quantity: number | null
  reorder_level: number | null
  line_status: RequirementStatus
  message: string | null
}

export const fetchBomRequirements = (bomId: string, quantity: number, warehouseId: string | null) =>
  rpc<RequirementLine[]>('production_bom_requirements', { p_bom_id: bomId, p_quantity: quantity, p_warehouse_id: warehouseId })

// ---------------------------------------------------------------------------
// Production orders
// ---------------------------------------------------------------------------
export async function fetchProductionOrders(status: ProductionStatus | 'OPEN' | null): Promise<ProductionOrderListRow[]> {
  let query = db().from('production_order_list').select('*').order('created_at', { ascending: false }).limit(2000)
  if (status === 'OPEN') query = query.not('status', 'in', '(COMPLETED,CANCELLED)')
  else if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

/** Orders that can receive material issues or output (in production). */
export const fetchRunningOrders = async () =>
  (await fetchProductionOrders(null)).filter((o) => o.status === 'IN_PROGRESS' || o.status === 'PARTIALLY_COMPLETED')

export async function fetchProductionOrder(id: string): Promise<ProductionOrderListRow> {
  const { data, error } = await db().from('production_order_list').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

export interface OrderRequirementLine {
  order_material_id: string
  line_no: number
  component_product_id: string
  sku: string
  product_name: string
  unit: string
  inventory_unit: string
  quantity_per_unit: number
  wastage_percentage: number
  base_quantity: number
  planned_quantity: number
  issued_quantity: number
  outstanding_quantity: number
  reserved_for_order: number
  available_in_source: number
  shortage: number | null
  line_status: 'UNIT_MISMATCH' | 'ISSUED' | 'INACTIVE' | 'RESERVED' | 'SUFFICIENT' | 'PARTIAL' | 'SHORTAGE'
}

export const fetchOrderRequirements = (orderId: string) => rpc<OrderRequirementLine[]>('production_order_requirements', { p_order_id: orderId })

export async function fetchOrderReservations(orderId: string): Promise<ReservationRow[]> {
  const { data, error } = await db()
    .from('stock_reservations')
    .select('*')
    .eq('reference_type', 'PRODUCTION_ORDER')
    .eq('reference_id', orderId)
    .order('reserved_at')
  if (error) throw error
  return data ?? []
}

export async function fetchProductionEvents(orderId: string): Promise<ProductionEventRow[]> {
  const { data, error } = await db().from('production_order_events').select('*').eq('production_order_id', orderId).order('created_at')
  if (error) throw error
  return data ?? []
}

export async function fetchConsumption(filters: { orderId?: string | null; from?: string; to?: string }): Promise<ConsumptionListRow[]> {
  let query = db().from('production_consumption_list').select('*').order('created_at', { ascending: false }).limit(3000)
  if (filters.orderId) query = query.eq('production_order_id', filters.orderId)
  if (filters.from) query = query.gte('consumption_date', filters.from)
  if (filters.to) query = query.lte('consumption_date', filters.to)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function fetchOutputs(filters: { orderId?: string | null; from?: string; to?: string }): Promise<OutputListRow[]> {
  let query = db().from('production_output_list').select('*').order('created_at', { ascending: false }).limit(3000)
  if (filters.orderId) query = query.eq('production_order_id', filters.orderId)
  if (filters.from) query = query.gte('production_date', filters.from)
  if (filters.to) query = query.lte('production_date', filters.to)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export interface OrderInput {
  orderId: string | null
  bomId: string
  plannedQuantity: number
  sourceWarehouseId: string
  destinationWarehouseId: string
  plannedStartDate: string
  targetCompletionDate: string
  priority: ProductionPriority
  notes: string | null
}

export const saveProductionOrder = (input: OrderInput, key: string) =>
  rpc<{ order_id: string; production_order_number: string; duplicate?: boolean }>('production_save_order', {
    p_order_id: input.orderId,
    p_bom_id: input.bomId,
    p_planned_quantity: input.plannedQuantity,
    p_source_warehouse_id: input.sourceWarehouseId,
    p_destination_warehouse_id: input.destinationWarehouseId,
    p_planned_start_date: input.plannedStartDate,
    p_target_completion_date: input.targetCompletionDate,
    p_priority: input.priority,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export type OrderAction = 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'START' | 'HOLD' | 'RESUME' | 'CANCEL' | 'COMPLETE'
export interface Discrepancy {
  type: 'OUTPUT_SHORT' | 'MATERIAL_UNDER_ISSUED' | 'RECEIPT_SHORT' | 'MATERIAL_HELD'
  sku?: string
  planned?: number
  actual?: number
  issued?: number
  expected?: number
  ordered?: number
  received?: number
  held?: number
  unit?: string
}

export const productionOrderAction = (orderId: string, action: OrderAction, note: string | null, key: string) =>
  rpc<{ status: ProductionStatus; released_reservation_quantity: number; discrepancies: Discrepancy[] }>('production_order_action', {
    p_order_id: orderId,
    p_action: action,
    p_note: note,
    p_idempotency_key: key,
  })

/** V2 single-operator: submit + approve in one step; the order is ready to reserve and start. */
export const releaseProductionOrder = (orderId: string, note: string | null) =>
  rpc<{ status: ProductionStatus }>('production_order_release', { p_order_id: orderId, p_note: note })

export const reserveMaterials = (orderId: string, allowPartial: boolean, key: string) =>
  rpc<{
    reservations: { reservation_number: string; sku: string; quantity: number }[]
    shortages: { sku: string; short: number; unit: string }[]
    fully_reserved: boolean
    status: ProductionStatus
  }>('production_reserve_materials', { p_order_id: orderId, p_allow_partial: allowPartial, p_idempotency_key: key })

export const releaseOrderReservations = (orderId: string, note: string | null) =>
  rpc<{ released_quantity: number; status: ProductionStatus }>('production_release_reservations', { p_order_id: orderId, p_note: note })

export interface IssueLine {
  order_material_id: string
  batch_id: string
  location_id: string
  quantity: number
}

export const issueMaterials = (
  input: { orderId: string; lines: IssueLine[]; consumptionDate: string; overIssueReason: string | null; notes: string | null },
  key: string,
) =>
  rpc<{ transaction_numbers: string[] }>('production_issue_materials', {
    p_order_id: input.orderId,
    p_lines: input.lines,
    p_consumption_date: input.consumptionDate,
    p_over_issue_reason: input.overIssueReason,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export const reverseConsumption = (consumptionId: string, reason: string, key: string) =>
  rpc<{ reversal_numbers: string[] }>('production_reverse_consumption', { p_consumption_id: consumptionId, p_reason: reason, p_idempotency_key: key })

export interface OutputInput {
  orderId: string
  goodQuantity: number
  rejectedQuantity: number
  scrapQuantity: number
  goodLocationId: string | null
  rejectedLocationId: string | null
  batchNumber: string | null
  manufacturingDate: string | null
  expiryDate: string | null
  productionDate: string
  unitCost: number | null
  qualityStatus: QualityStatus
  rejectionReason: string | null
  overProductionReason: string | null
  notes: string | null
}

export const receiveOutput = (input: OutputInput, key: string) =>
  rpc<{ receipt_id: string; receipt_number: string; good_transaction_number: string | null; rejected_transaction_number: string | null }>(
    'production_receive_output',
    {
      p_order_id: input.orderId,
      p_good_quantity: input.goodQuantity,
      p_rejected_quantity: input.rejectedQuantity,
      p_scrap_quantity: input.scrapQuantity,
      p_good_location_id: input.goodLocationId,
      p_rejected_location_id: input.rejectedLocationId,
      p_batch_number: input.batchNumber,
      p_manufacturing_date: input.manufacturingDate,
      p_expiry_date: input.expiryDate,
      p_production_date: input.productionDate,
      p_unit_cost: input.unitCost,
      p_quality_status: input.qualityStatus,
      p_rejection_reason: input.rejectionReason,
      p_over_production_reason: input.overProductionReason,
      p_notes: input.notes,
      p_idempotency_key: key,
    },
  )

export const reverseOutput = (receiptId: string, reason: string, key: string) =>
  rpc<{ reversal_numbers: string[] }>('production_reverse_output', { p_receipt_id: receiptId, p_reason: reason, p_idempotency_key: key })

/**
 * Usable lots (storage locations: available or reserved > 0) of products in a
 * warehouse, for picking what to issue or dispatch.
 */
export async function fetchUsableLots(productIds: string[], warehouseId: string | null): Promise<StockDetailRow[]> {
  if (productIds.length === 0) return []
  let query = db().from('inventory_stock_detail').select('*').in('product_id', productIds).gt('on_hand', 0)
  if (warehouseId) query = query.eq('warehouse_id', warehouseId)
  const { data, error } = await query.order('expiry_date', { ascending: true, nullsFirst: false }).order('location_code')
  if (error) throw error
  return ((data ?? []) as StockDetailRow[]).filter((r) => Number(r.available) + Number(r.reserved) > 0)
}

/** Lots of products held at one location (e.g. the supplier's external-processing location). */
export async function fetchLotsAtLocation(productIds: string[], locationId: string): Promise<StockDetailRow[]> {
  if (productIds.length === 0) return []
  const { data, error } = await db().from('inventory_stock_detail').select('*').in('product_id', productIds).eq('location_id', locationId).gt('on_hand', 0)
  if (error) throw error
  return (data ?? []) as StockDetailRow[]
}

export async function fetchProductFlags(productId: string) {
  const { data, error } = await db().from('products').select('id, sku, product_name, base_unit, track_batches, track_expiry').eq('id', productId).single()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Outsourcing
// ---------------------------------------------------------------------------
export async function fetchOutsourcingOrders(status: OutsourcingStatus | 'OPEN' | null): Promise<OutsourcingOrderListRow[]> {
  let query = db().from('outsourcing_order_list').select('*').order('created_at', { ascending: false }).limit(2000)
  if (status === 'OPEN') query = query.not('status', 'in', '(COMPLETED,CANCELLED)')
  else if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function fetchOutsourcingOrder(id: string) {
  const [order, materials, receipts, movements, events] = await Promise.all([
    db().from('outsourcing_order_list').select('*').eq('id', id).single(),
    db().from('outsourcing_material_list').select('*').eq('outsourcing_order_id', id).order('line_no'),
    db().from('outsourcing_receipt_list').select('*').eq('outsourcing_order_id', id).order('created_at'),
    db().from('outsourcing_movement_list').select('*').eq('outsourcing_order_id', id).order('created_at'),
    db().from('outsourcing_order_events').select('*').eq('outsourcing_order_id', id).order('created_at'),
  ])
  for (const r of [order, materials, receipts, movements, events]) if (r.error) throw r.error
  return {
    order: order.data as OutsourcingOrderListRow,
    materials: (materials.data ?? []) as OutsourcingMaterialListRow[],
    receipts: (receipts.data ?? []) as OutsourcingReceiptListRow[],
    movements: (movements.data ?? []) as OutsourcingMovementListRow[],
    events: (events.data ?? []) as OutsourcingEventRow[],
  }
}

export async function fetchOutsourcingMaterials(orderId: string): Promise<OutsourcingMaterialListRow[]> {
  const { data, error } = await db().from('outsourcing_material_list').select('*').eq('outsourcing_order_id', orderId).order('line_no')
  if (error) throw error
  return data ?? []
}

export async function fetchOutsourcingReceipts(filters: { from?: string; to?: string }): Promise<OutsourcingReceiptListRow[]> {
  let query = db().from('outsourcing_receipt_list').select('*').order('created_at', { ascending: false }).limit(3000)
  if (filters.from) query = query.gte('receipt_date', filters.from)
  if (filters.to) query = query.lte('receipt_date', filters.to)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export interface OutsourcingOrderInput {
  orderId: string | null
  orderType: OutsourcingType
  productId: string
  bomId: string | null
  orderedQuantity: number
  supplierName: string
  supplierReference: string | null
  expectedReturnDate: string
  destinationWarehouseId: string
  externalLocationId: string | null
  referenceNumber: string | null
  unitCost: number | null
  notes: string | null
  materials: { product_id: string; quantity: number }[]
}

export const saveOutsourcingOrder = (input: OutsourcingOrderInput, key: string) =>
  rpc<{ order_id: string; outsourcing_order_number: string; duplicate?: boolean }>('outsourcing_save_order', {
    p_order_id: input.orderId,
    p_order_type: input.orderType,
    p_product_id: input.productId,
    p_bom_id: input.bomId,
    p_ordered_quantity: input.orderedQuantity,
    p_supplier_name: input.supplierName,
    p_supplier_reference: input.supplierReference,
    p_expected_return_date: input.expectedReturnDate,
    p_destination_warehouse_id: input.destinationWarehouseId,
    p_external_location_id: input.externalLocationId,
    p_reference_number: input.referenceNumber,
    p_unit_cost: input.unitCost,
    p_notes: input.notes,
    p_materials: input.materials,
    p_idempotency_key: key,
  })

export type OutsourcingAction = 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'HOLD' | 'RESUME' | 'CANCEL' | 'COMPLETE'
export const outsourcingOrderAction = (orderId: string, action: OutsourcingAction, note: string | null, key: string) =>
  rpc<{ status: OutsourcingStatus; discrepancies: Discrepancy[] }>('outsourcing_order_action', {
    p_order_id: orderId,
    p_action: action,
    p_note: note,
    p_idempotency_key: key,
  })

/** V2 single-operator: submit + approve in one step. */
export const releaseOutsourcingOrder = (orderId: string, note: string | null) =>
  rpc<{ status: OutsourcingStatus }>('outsourcing_order_release', { p_order_id: orderId, p_note: note })

export const moveOutsourcingMaterials = (
  input: { orderId: string; movementType: 'DISPATCH' | 'RETURN'; lines: IssueLine[]; movementDate: string; overReason: string | null; notes: string | null },
  key: string,
) =>
  rpc<{ transaction_numbers: string[]; status: OutsourcingStatus }>('outsourcing_move_materials', {
    p_order_id: input.orderId,
    p_movement_type: input.movementType,
    p_lines: input.lines,
    p_movement_date: input.movementDate,
    p_over_reason: input.overReason,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export interface OutsourcedReceiptInput {
  orderId: string
  receivedQuantity: number
  acceptedQuantity: number
  rejectedQuantity: number
  acceptedLocationId: string | null
  rejectedLocationId: string | null
  batchNumber: string | null
  manufacturingDate: string | null
  expiryDate: string | null
  receiptDate: string
  unitCost: number | null
  supplierDocumentNumber: string | null
  rejectionDisposition: RejectionDisposition | null
  rejectionReason: string | null
  overReceiptReason: string | null
  consumption: { order_material_id: string; batch_id: string; quantity: number }[]
  notes: string | null
}

export const receiveOutsourcedGoods = (input: OutsourcedReceiptInput, key: string) =>
  rpc<{ receipt_id: string; receipt_number: string; accepted_transaction_number: string | null; rejected_transaction_number: string | null }>(
    'outsourcing_receive_goods',
    {
      p_order_id: input.orderId,
      p_received_quantity: input.receivedQuantity,
      p_accepted_quantity: input.acceptedQuantity,
      p_rejected_quantity: input.rejectedQuantity,
      p_accepted_location_id: input.acceptedLocationId,
      p_rejected_location_id: input.rejectedLocationId,
      p_batch_number: input.batchNumber,
      p_manufacturing_date: input.manufacturingDate,
      p_expiry_date: input.expiryDate,
      p_receipt_date: input.receiptDate,
      p_unit_cost: input.unitCost,
      p_supplier_document_number: input.supplierDocumentNumber,
      p_rejection_disposition: input.rejectionDisposition,
      p_rejection_reason: input.rejectionReason,
      p_over_receipt_reason: input.overReceiptReason,
      p_consumption: input.consumption,
      p_notes: input.notes,
      p_idempotency_key: key,
    },
  )

export const reverseOutsourcedReceipt = (receiptId: string, reason: string, key: string) =>
  rpc<{ reversal_numbers: string[] }>('outsourcing_reverse_receipt', { p_receipt_id: receiptId, p_reason: reason, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Overview, reports, traceability
// ---------------------------------------------------------------------------
export type UnitQty = { unit: string; [k: string]: string | number }

export interface ProductionOverview {
  has_records: boolean
  open_orders: number
  draft_orders: number
  in_progress_orders: number
  on_hold_orders: number
  overdue_orders: number
  completed_orders: number
  planned_open: { unit: string; planned: number; remaining: number }[]
  produced_this_month: { unit: string; good: number; rejected: number; scrap: number }[]
  produced_in_period: { unit: string; good: number; rejected: number; scrap: number }[]
  shortage_materials: number
  outsourcing_in_progress: number
  pending_order_approvals: number
  pending_bom_approvals: number
  pending_outsourcing_approvals: number
  planned_vs_actual: { bucket: string; unit: string; planned: number; actual: number }[]
  by_product: { sku: string; product_name: string; unit: string; good: number; rejected: number; scrap: number }[]
  by_status: { status: ProductionStatus; orders: number }[]
  source_split: { bucket: string; unit: string; in_house: number; outsourced: number }[]
  consumption_trend: { bucket: string; unit: string; quantity: number }[]
  shortages: {
    sku: string
    product_name: string
    unit: string
    warehouse_code: string
    outstanding: number
    available: number
    reserved_for_orders: number
    shortage: number
    orders: number
  }[]
  timezone: string
  today: string
  as_of: string
}

export const fetchProductionOverview = (filters: {
  from: string
  to: string
  warehouseId: string | null
  productId: string | null
  status: ProductionStatus | null
  bucket: 'day' | 'week' | 'month' | 'year'
}) =>
  rpc<ProductionOverview>('production_overview', {
    p_from: filters.from,
    p_to: filters.to,
    p_warehouse_id: filters.warehouseId,
    p_product_id: filters.productId,
    p_status: filters.status,
    p_bucket: filters.bucket,
  })

export type ProductionReportKey =
  | 'ORDERS_SUMMARY'
  | 'PLANNED_VS_ACTUAL'
  | 'RAW_MATERIAL_REQUIREMENTS'
  | 'MATERIAL_SHORTAGE'
  | 'PLANNED_VS_ACTUAL_CONSUMPTION'
  | 'OUTPUT_AND_REJECTIONS'
  | 'FINISHED_GOODS_PRODUCED'
  | 'OUTSOURCING_REGISTER'
  | 'MATERIALS_HELD_BY_SUPPLIERS'
  | 'OUTSOURCED_RECEIPTS'
  | 'IN_HOUSE_VS_OUTSOURCED'
  | 'BATCH_TRACEABILITY'
  | 'COST_SUMMARY'
  | 'VARIANCE'

export const fetchProductionReport = (
  report: ProductionReportKey,
  filters: { from: string; to: string; productId: string | null; bomId: string | null; status: string | null; warehouseId: string | null; supplier: string | null },
) =>
  rpc<Record<string, unknown>[]>('production_report', {
    p_report: report,
    p_from: filters.from,
    p_to: filters.to,
    p_product_id: filters.productId,
    p_bom_id: filters.bomId,
    p_status: filters.status,
    p_warehouse_id: filters.warehouseId,
    p_supplier: filters.supplier,
  })

export interface TraceMaterial {
  batch_id: string
  sku: string
  product_name: string
  batch_number: string | null
  source_type: string
  quantity: number
  unit: string
  date: string
}

export interface TraceOutput {
  batch_id: string | null
  sku: string
  product_name: string
  batch_number: string | null
  good: number
  receipt_number: string
  date: string
}

export interface TraceResult {
  batch: {
    batch_id: string
    sku: string
    product_name: string
    unit: string
    batch_number: string | null
    is_system_lot: boolean
    source_type: string
    manufacturing_date: string | null
    expiry_date: string | null
    created_at: string
    on_hand: number
  }
  completeness: {
    inflow_quantity: number
    linked_inflow_quantity: number
    unlinked_inflow_quantity: number
    pooled_lot: boolean
    warnings: string[]
  }
  produced_by: {
    kind: 'PRODUCTION' | 'OUTSOURCING'
    order_id: string
    order_number: string
    supplier_name?: string
    receipt_number: string
    date: string
    good: number
    rejected: number
    unit: string
    materials: TraceMaterial[]
  }[]
  used_in: {
    kind: 'PRODUCTION' | 'OUTSOURCING'
    order_id: string
    order_number: string
    supplier_name?: string
    date: string
    quantity: number
    unit: string
    order_status: string
    outputs: TraceOutput[]
  }[]
  history: {
    transaction_number: string
    transaction_type: string
    direction: number
    quantity: number
    unit: string
    transaction_date: string
    warehouse_code: string
    location_code: string
    stock_usage: string
    reference_type: string | null
    reference_number: string | null
    reason: string
  }[]
}

export const traceBatch = (batchId: string) => rpc<TraceResult>('production_trace_batch', { p_batch_id: batchId })

/** Batch / lot search for traceability (batch number, SKU or product name). */
export async function searchLots(term: string): Promise<(BatchRow & { sku: string; product_name: string })[]> {
  const clean = term.replace(/[^\p{L}\p{N} ._/-]/gu, ' ').trim().slice(0, 50)
  if (!clean) return []
  const products = await db().from('products').select('id, sku, product_name').or(`sku.ilike.%${clean}%,product_name.ilike.%${clean}%`).limit(20)
  if (products.error) throw products.error
  const ids = (products.data ?? []).map((p) => p.id)
  let query = db().from('inventory_batches').select('*').order('created_at', { ascending: false }).limit(30)
  query = ids.length ? query.or(`batch_number.ilike.%${clean}%,product_id.in.(${ids.join(',')})`) : query.ilike('batch_number', `%${clean}%`)
  const { data, error } = await query
  if (error) throw error
  const lots = data ?? []
  const missing = [...new Set(lots.map((l) => l.product_id).filter((id) => !ids.includes(id)))]
  let extra: { id: string; sku: string; product_name: string }[] = []
  if (missing.length) {
    const r = await db().from('products').select('id, sku, product_name').in('id', missing)
    if (r.error) throw r.error
    extra = r.data ?? []
  }
  const byId = new Map([...(products.data ?? []), ...extra].map((p) => [p.id, p]))
  return lots.map((l) => ({ ...l, sku: byId.get(l.product_id)?.sku ?? '?', product_name: byId.get(l.product_id)?.product_name ?? '' }))
}
