import { requireSupabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import type {
  CustomerReturnLineListRow,
  CustomerReturnListRow,
  DeliveryEventRow,
  DeliveryEventType,
  Disposition,
  FulfilmentLineListRow,
  FulfilmentListRow,
  FulfilmentStatus,
  Priority,
  ReturnReason,
  ReturnStatus,
  SalesOrderEventRow,
  SalesOrderLineListRow,
  SalesOrderListRow,
  SalesOrderReservationRow,
  SalesOrderStatus,
} from '@/types/database-sales'

/**
 * Sales order and fulfilment data access. Reads go through RLS-protected
 * views; every change (conversion, confirmation, allocation, picking, packing,
 * dispatch, delivery, returns, cancellation) is a SECURITY DEFINER function
 * that re-validates status, quantities, reservations and permissions. Stock
 * moves only in fulfilment_dispatch and the return functions, through the
 * Phase 4 ledger. Nothing here is computed in the browser and trusted.
 */

const db = () => requireSupabase()

async function rpc<T = Json>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------
export type OrderStatusFilter = SalesOrderStatus | 'OPEN' | 'NEEDS_ACTION' | null

export interface OrderListFilters {
  search: string
  status: OrderStatusFilter
  customerId: string | null
  source: 'CUSTOMER_PO' | 'MANUAL' | null
  from: string | null
  to: string | null
}

const OPEN_STATUSES: SalesOrderStatus[] = ['PENDING_CONFIRMATION', 'CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED', 'ON_HOLD']

/** Server-side paginated order list (search, filters and paging run in the database). */
export async function fetchOrdersPage(filters: OrderListFilters, page: number, pageSize: number): Promise<{ rows: SalesOrderListRow[]; total: number }> {
  let query = db().from('sales_order_list').select('*', { count: 'exact' })
  if (filters.status === 'OPEN') query = query.in('order_status', OPEN_STATUSES)
  else if (filters.status === 'NEEDS_ACTION') query = query.in('order_status', ['PENDING_CONFIRMATION', 'ON_HOLD'])
  else if (filters.status) query = query.eq('order_status', filters.status)
  if (filters.customerId) query = query.eq('customer_id', filters.customerId)
  if (filters.source) query = query.eq('source', filters.source)
  if (filters.from) query = query.gte('order_date', filters.from)
  if (filters.to) query = query.lte('order_date', filters.to)
  const term = filters.search.trim().replace(/[%,()*]/g, ' ').trim()
  if (term) query = query.or(`sales_order_number.ilike.%${term}%,customer_name_snapshot.ilike.%${term}%,customer_po_number.ilike.%${term}%`)
  const from = page * pageSize
  const { data, error, count } = await query.order('order_date', { ascending: false }).order('sales_order_number', { ascending: false }).range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: (data ?? []) as SalesOrderListRow[], total: count ?? 0 }
}

/** Orders for selectors (most recent first, bounded). */
export async function fetchOrderOptions(statuses: SalesOrderStatus[] | null): Promise<SalesOrderListRow[]> {
  let query = db().from('sales_order_list').select('*').order('created_at', { ascending: false }).limit(1000)
  if (statuses) query = query.in('order_status', statuses)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as SalesOrderListRow[]
}

export async function fetchOrdersForPo(poId: string): Promise<SalesOrderListRow[]> {
  const { data, error } = await db().from('sales_order_list').select('*').eq('customer_purchase_order_id', poId).order('created_at')
  if (error) throw error
  return (data ?? []) as SalesOrderListRow[]
}

export async function fetchOrder(id: string): Promise<SalesOrderListRow> {
  const { data, error } = await db().from('sales_order_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as SalesOrderListRow
}

export async function fetchOrderLines(filters: { orderId?: string | null; backorderedOnly?: boolean; openOnly?: boolean }): Promise<SalesOrderLineListRow[]> {
  let query = db().from('sales_order_line_list').select('*').order('order_date', { ascending: true }).order('sales_order_number').order('line_no').limit(5000)
  if (filters.orderId) query = query.eq('sales_order_id', filters.orderId)
  if (filters.openOnly) query = query.gt('quantity_remaining', 0).not('order_status', 'in', '(CANCELLED,FULFILLED,DRAFT)')
  if (filters.backorderedOnly) query = query.gt('quantity_unreserved', 0)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as SalesOrderLineListRow[]
}

export async function fetchOrderReservations(orderId: string): Promise<SalesOrderReservationRow[]> {
  const { data, error } = await db().from('sales_order_reservation_list').select('*').eq('sales_order_id', orderId).order('line_no').order('reserved_at')
  if (error) throw error
  return (data ?? []) as SalesOrderReservationRow[]
}

export async function fetchOrderEvents(orderId: string): Promise<SalesOrderEventRow[]> {
  const { data, error } = await db().from('sales_order_events').select('*').eq('sales_order_id', orderId).order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function fetchOrderMovements(orderId: string) {
  const { data, error } = await db()
    .from('inventory_transaction_list')
    .select('id, transaction_number, transaction_type, quantity, unit, sku, product_name, batch_number, warehouse_code, location_code, transaction_date, reference_number')
    .eq('document_type', 'SALES_ORDER')
    .eq('document_id', orderId)
    .order('transaction_date', { ascending: false })
  if (error) throw error
  return data ?? []
}

export interface PoCandidate {
  po_id: string
  po_reference: string
  customer_po_number: string
  revision: number
  customer_name: string
  po_date: string
  required_delivery_date: string | null
  status: string
  sales_orders: string | null
  convertible_quantity: number
}

export const fetchPoCandidates = () => rpc<PoCandidate[]>('sales_order_po_candidates', {})

export interface PoConversionLine {
  po_line_id: string
  line_no: number
  product_id: string | null
  sku: string | null
  product_name: string | null
  product_status: string | null
  base_unit: string | null
  unit: string | null
  line_status: string
  quantity_ordered: number
  dispatched_by_po: number
  converted: number
  convertible: number
  po_reserved: number
  unit_price: number | null
  currency: string | null
  reservations: { reservation_number: string; remaining: number; warehouse_code: string; location_code: string; batch_number: string | null; source_type: string }[]
}

export interface PoConversionPreview {
  po: {
    po_id: string
    po_reference: string
    customer_po_number: string
    revision: number
    customer_id: string | null
    customer_name: string
    customer_code: string | null
    po_date: string
    required_delivery_date: string | null
    currency: string | null
    status: string
    fulfilment_warehouse_id: string | null
    source_filename: string | null
    is_current: boolean
  }
  existing_sales_orders: { id: string; sales_order_number: string; order_status: SalesOrderStatus }[]
  blockers: string[]
  lines: PoConversionLine[]
}

export const fetchPoConversionPreview = (poId: string) => rpc<PoConversionPreview>('sales_order_po_preview', { p_po_id: poId })

export interface OrderHeaderInput {
  requested_delivery_date?: string | null
  shipping_address?: string | null
  billing_address?: string | null
  customer_reference?: string | null
  priority?: Priority
  warehouse_id?: string | null
  internal_notes?: string | null
}

export type CreateOrderResult = { sales_order_id: string; sales_order_number: string; status: SalesOrderStatus; lines: number; transferred_reserved?: number; duplicate?: boolean }

export const createOrderFromPo = (
  input: { poId: string; header: OrderHeaderInput; lines: { po_line_id: string; quantity: number }[] | null; split: boolean; confirm: boolean },
  key: string,
) =>
  rpc<CreateOrderResult>('sales_order_create_from_po', {
    p_po_id: input.poId,
    p_header: input.header,
    p_lines: input.lines,
    p_split: input.split,
    p_confirm: input.confirm,
    p_idempotency_key: key,
  })

export const createManualOrder = (
  header: OrderHeaderInput & { customer_id: string; customer_po_number?: string | null; order_date?: string | null; currency?: string | null },
  lines: { product_id: string; quantity: number; unit_price: number | null }[],
  confirm: boolean,
  key: string,
) => rpc<CreateOrderResult>('sales_order_create_manual', { p_header: header, p_lines: lines, p_confirm: confirm, p_idempotency_key: key })

export const confirmOrder = (id: string, note: string | null) => rpc<{ status: SalesOrderStatus }>('sales_order_confirm', { p_so_id: id, p_note: note })
export const updateOrder = (id: string, changes: OrderHeaderInput) => rpc('sales_order_update', { p_so_id: id, p_changes: changes })
export const orderAction = (id: string, action: 'HOLD' | 'RESUME', note: string | null) => rpc<{ status: SalesOrderStatus }>('sales_order_action', { p_so_id: id, p_action: action, p_note: note })

export type SoStrategy = 'IN_HOUSE_FIRST' | 'OUTSOURCED_FIRST' | 'EARLIEST_BATCH'
export interface SoAllocateResult {
  reservations: { reservation_number: string; line_no: number; sku: string; quantity: number; source_type: string; warehouse_code: string; location_code: string; batch_number: string | null }[]
  shortages: { line_no: number; sku: string; short: number; unit: string }[]
  status: SalesOrderStatus
  duplicate?: boolean
}
export const allocateOrder = (id: string, strategy: SoStrategy, lineId: string | null, allowPartial: boolean, key: string) =>
  rpc<SoAllocateResult>('sales_order_allocate', { p_so_id: id, p_strategy: strategy, p_line_id: lineId, p_allow_partial: allowPartial, p_idempotency_key: key })

export const releaseOrder = (id: string, lineId: string | null, reservationId: string | null, note: string | null) =>
  rpc<{ released_quantity: number; reservations: number; status: SalesOrderStatus }>('sales_order_release', { p_so_id: id, p_line_id: lineId, p_reservation_id: reservationId, p_note: note })

export const updateOrderLine = (lineId: string, input: { backorderReason: string | null; expectedDate: string | null; cancelQuantity: number | null; note: string | null }) =>
  rpc<{ status: SalesOrderStatus; released_quantity: number }>('sales_order_line_update', {
    p_line_id: lineId,
    p_backorder_reason: input.backorderReason,
    p_expected_date: input.expectedDate,
    p_cancel_quantity: input.cancelQuantity,
    p_note: input.note,
  })

export interface CancelPreview {
  sales_order_number: string
  order_status: SalesOrderStatus
  can_cancel: boolean
  blocked_reason: string | null
  has_dispatches: boolean
  lines: { line_no: number; sku: string; unit: string; ordered: number; cancelled: number; dispatched: number; delivered: number; reserved: number; planned: number; will_cancel: number }[]
  fulfilments: { fulfilment_number: string; status: FulfilmentStatus; picked: number; packed: number; dispatched: number; will_cancel: boolean }[]
  reservations: { reservation_number: string; line_no: number; sku: string; remaining: number; warehouse_code: string; location_code: string; batch_number: string | null }[]
  movements: { transaction_number: string; transaction_type: string; quantity: number; unit: string; transaction_date: string }[]
}
export const fetchCancelPreview = (id: string) => rpc<CancelPreview>('sales_order_cancel_preview', { p_so_id: id })
export const cancelOrder = (id: string, reason: string, key: string) =>
  rpc<{ status: SalesOrderStatus; released_quantity: number; fulfilments_cancelled: number; dispatched_kept: number }>('sales_order_cancel', { p_so_id: id, p_reason: reason, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Fulfilments: picking, packing, dispatch, delivery
// ---------------------------------------------------------------------------
export async function fetchFulfilments(filters: { statuses?: FulfilmentStatus[]; orderId?: string | null; search?: string; overdueOnly?: boolean }): Promise<FulfilmentListRow[]> {
  let query = db().from('fulfilment_list').select('*').order('created_at', { ascending: false }).limit(2000)
  if (filters.statuses?.length) query = query.in('fulfilment_status', filters.statuses)
  if (filters.orderId) query = query.eq('sales_order_id', filters.orderId)
  if (filters.overdueOnly) query = query.eq('is_overdue', true)
  const term = (filters.search ?? '').trim().replace(/[%,()*]/g, ' ').trim()
  if (term) query = query.or(`fulfilment_number.ilike.%${term}%,sales_order_number.ilike.%${term}%,tracking_number.ilike.%${term}%,lr_number.ilike.%${term}%,customer_name_snapshot.ilike.%${term}%`)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as FulfilmentListRow[]
}

export async function fetchFulfilment(id: string): Promise<FulfilmentListRow> {
  const { data, error } = await db().from('fulfilment_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as FulfilmentListRow
}

export async function fetchFulfilmentLines(filters: { fulfilmentId?: string; orderId?: string; dispatchedOnly?: boolean }): Promise<FulfilmentLineListRow[]> {
  let query = db().from('fulfilment_line_list').select('*').order('fulfilment_number').order('line_no').limit(5000)
  if (filters.fulfilmentId) query = query.eq('fulfilment_id', filters.fulfilmentId)
  if (filters.orderId) query = query.eq('sales_order_id', filters.orderId)
  if (filters.dispatchedOnly) query = query.gt('quantity_dispatched', 0)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as FulfilmentLineListRow[]
}

export async function fetchDeliveryEvents(fulfilmentId: string): Promise<DeliveryEventRow[]> {
  const { data, error } = await db().from('delivery_events').select('*').eq('fulfilment_id', fulfilmentId).order('event_at', { ascending: true }).order('created_at')
  if (error) throw error
  return data ?? []
}

export const createFulfilment = (
  input: { orderId: string; warehouseId: string; lines: { reservation_id: string; quantity: number }[] | null; plannedDispatchDate: string | null; notes: string | null },
  key: string,
) =>
  rpc<{ fulfilment_id: string; fulfilment_number: string; lines: number; order_status: SalesOrderStatus; duplicate?: boolean }>('fulfilment_create', {
    p_so_id: input.orderId,
    p_warehouse_id: input.warehouseId,
    p_lines: input.lines,
    p_planned_dispatch_date: input.plannedDispatchDate,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export const recordPick = (id: string, lines: { line_id: string; quantity_picked: number; exception: string | null }[], complete: boolean) =>
  rpc<{ status: FulfilmentStatus; picked: number }>('fulfilment_pick', { p_fulfilment_id: id, p_lines: lines, p_complete: complete })

export const recordPack = (id: string, lines: { line_id: string; quantity_packed: number; quantity_damaged: number; exception: string | null }[], packingNotes: string | null, complete: boolean) =>
  rpc<{ status: FulfilmentStatus; packed: number }>('fulfilment_pack', { p_fulfilment_id: id, p_lines: lines, p_packing_notes: packingNotes, p_complete: complete })

export type FulfilmentAction = 'READY' | 'REOPEN_PACKING' | 'REOPEN_PICKING' | 'CANCEL'
export const fulfilmentAction = (id: string, action: FulfilmentAction, reason: string | null) =>
  rpc<{ status: FulfilmentStatus }>('fulfilment_action', { p_fulfilment_id: id, p_action: action, p_reason: reason })

export interface DispatchDetails {
  carrier_name?: string | null
  transport_mode?: string | null
  vehicle_number?: string | null
  lr_number?: string | null
  tracking_number?: string | null
  eway_bill_number?: string | null
  delivery_reference?: string | null
  document_references?: string | null
  notes?: string | null
  dispatched_at?: string | null
  expected_delivery_date?: string | null
}

export const dispatchFulfilment = (id: string, details: DispatchDetails, key: string) =>
  rpc<{ transaction_numbers: string[]; dispatched_quantity: number; fulfilment_status: FulfilmentStatus; order_status: SalesOrderStatus; duplicate?: boolean }>('fulfilment_dispatch', {
    p_fulfilment_id: id,
    p_details: details,
    p_idempotency_key: key,
  })

export const recordDelivery = (
  id: string,
  input: { eventType: Exclude<DeliveryEventType, 'DISPATCHED'>; eventAt: string | null; location: string | null; description: string | null; reference: string | null; failureReason: string | null; lines: { line_id: string; quantity: number }[] | null },
  key: string,
) =>
  rpc<{ status: FulfilmentStatus; delivered: { line_no: number; quantity: number }[] }>('fulfilment_record_delivery', {
    p_fulfilment_id: id,
    p_event_type: input.eventType,
    p_event_at: input.eventAt,
    p_location: input.location,
    p_description: input.description,
    p_reference: input.reference,
    p_failure_reason: input.failureReason,
    p_lines: input.lines,
    p_idempotency_key: key,
  })

export const fetchFulfilmentPolicy = () => rpc<{ dispatch_required_fields: string[] }>('fulfilment_policy', {})

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------
export async function fetchReturns(filters: { status?: ReturnStatus | 'OPEN' | null; orderId?: string | null }): Promise<CustomerReturnListRow[]> {
  let query = db().from('customer_return_list').select('*').order('created_at', { ascending: false }).limit(2000)
  if (filters.status === 'OPEN') query = query.not('status', 'in', '(CLOSED,REJECTED)')
  else if (filters.status) query = query.eq('status', filters.status)
  if (filters.orderId) query = query.eq('sales_order_id', filters.orderId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as CustomerReturnListRow[]
}

export async function fetchReturnLines(returnId: string): Promise<CustomerReturnLineListRow[]> {
  const { data, error } = await db().from('customer_return_line_list').select('*').eq('return_id', returnId).order('line_no')
  if (error) throw error
  return (data ?? []) as CustomerReturnLineListRow[]
}

export const createReturn = (
  orderId: string,
  header: { return_date: string | null; reason_code: ReturnReason; reason_note: string | null; customer_reference: string | null; notes: string | null },
  lines: { fulfilment_line_id: string; quantity: number }[],
  key: string,
) => rpc<{ return_id: string; return_number: string; lines: number; duplicate?: boolean }>('customer_return_create', { p_so_id: orderId, p_header: header, p_lines: lines, p_idempotency_key: key })

export const reviewReturn = (id: string, decision: 'AUTHORIZE' | 'REJECT', note: string | null) =>
  rpc<{ status: ReturnStatus }>('customer_return_review', { p_return_id: id, p_decision: decision, p_note: note })

export const receiveReturn = (id: string, locationId: string, lines: { line_id: string; quantity: number }[] | null, note: string | null, key: string) =>
  rpc<{ status: ReturnStatus; transaction_numbers: string[]; received: number }>('customer_return_receive', {
    p_return_id: id,
    p_location_id: locationId,
    p_lines: lines,
    p_received_at: null,
    p_note: note,
    p_idempotency_key: key,
  })

export const inspectReturn = (id: string, lines: { line_id: string; disposition: Disposition; note: string | null }[], result: 'ACCEPTED' | 'REJECTED' | null, note: string | null) =>
  rpc<{ status: ReturnStatus }>('customer_return_inspect', { p_return_id: id, p_lines: lines, p_result: result, p_note: note })

export const postReturnDisposition = (id: string, restockLocationId: string | null, scrapLocationId: string | null, note: string | null, key: string) =>
  rpc<{ status: ReturnStatus; transaction_numbers: string[] }>('customer_return_post_disposition', {
    p_return_id: id,
    p_restock_location_id: restockLocationId,
    p_scrap_location_id: scrapLocationId,
    p_note: note,
    p_idempotency_key: key,
  })

// ---------------------------------------------------------------------------
// Overview and reports
// ---------------------------------------------------------------------------
export interface SalesOverview {
  has_records: boolean
  total_orders: number
  awaiting_confirmation: number
  ready_for_picking: number
  being_packed: number
  ready_for_dispatch: number
  dispatched: number
  in_transit: number
  delivered: number
  partially_fulfilled: number
  with_exceptions: number
  units_awaiting: { unit: string; quantity: number }[]
  units_dispatched: { unit: string; quantity: number }[]
  by_status: { status: SalesOrderStatus; count: number }[]
  created_over_time: { bucket: string; count: number }[]
  ordered_vs_dispatched: { sku: string; product_name: string; unit: string; ordered: number; dispatched: number; remaining: number }[]
  pending_by_warehouse: { warehouse: string; unit: string; reserved: number; unallocated: number }[]
  delivery_performance: { delivered: number; on_time: number; late: number; no_expected_date: number; average_days_late: number | null; by_bucket: { bucket: string; on_time: number; late: number; no_expected_date: number }[] }
  overdue_deliveries: number
  returns_by_product_reason: { sku: string; product_name: string; unit: string; reason_code: ReturnReason; quantity: number; returns: number }[]
  timezone: string
  as_of: string
}

export const fetchSalesOverview = (filters: {
  from: string
  to: string
  customerId: string | null
  warehouseId: string | null
  orderStatus: string | null
  dispatchStatus: string | null
  deliveryStatus: string | null
  bucket: 'day' | 'week' | 'month' | 'year'
}) =>
  rpc<SalesOverview>('sales_overview', {
    p_from: filters.from,
    p_to: filters.to,
    p_customer_id: filters.customerId,
    p_warehouse_id: filters.warehouseId,
    p_order_status: filters.orderStatus,
    p_dispatch_status: filters.dispatchStatus,
    p_delivery_status: filters.deliveryStatus,
    p_bucket: filters.bucket,
  })

export type FulfilmentReportKey =
  | 'SALES_ORDER_REGISTER'
  | 'PENDING_FULFILMENT'
  | 'PICKING'
  | 'PACKING_STATUS'
  | 'DISPATCH_REGISTER'
  | 'PARTIAL_DISPATCH'
  | 'BACKORDER'
  | 'DELIVERY_TRACKING'
  | 'OVERDUE_DELIVERY'
  | 'RETURNS_REGISTER'
  | 'EXCEPTIONS'
  | 'TRACEABILITY'
  | 'PRODUCT_DISPATCH_QTY'
  | 'WAREHOUSE_PERFORMANCE'

export const fetchFulfilmentReport = (
  report: FulfilmentReportKey,
  f: { from: string; to: string; customerId: string | null; productId: string | null; warehouseId: string | null; status: string | null; transporter: string | null },
) =>
  rpc<Record<string, unknown>[]>('fulfilment_report', {
    p_report: report,
    p_from: f.from,
    p_to: f.to,
    p_customer_id: f.customerId,
    p_product_id: f.productId,
    p_warehouse_id: f.warehouseId,
    p_status: f.status,
    p_transporter: f.transporter,
  })
