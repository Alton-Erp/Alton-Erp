import { requireSupabase } from '@/lib/supabase'
import type { UnitQty } from '@/features/production/production-v2-model'
import type { ImportGroup, SalesImportRow, SoV2Status } from '@/features/sales/sales-v2-model'
import type { SalesOrderLineListRow, SalesOrderListRow } from '@/types/database-sales'

/**
 * Stage 5 sales orders (migration 20261106090000_sales_orders_v2.sql). Every
 * change goes through a SECURITY DEFINER function that checks permissions and
 * locks rows; reservations never move stock, only dispatch does.
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface SoV2Material { component_product_id: string; sku: string; product_name: string; unit: string; required: number; reserved: number }

export interface SoV2Line {
  line_id: string
  line_no: number
  product_id: string
  sku: string
  product_name: string
  description: string | null
  unit: string
  product_type: string
  ordered: number
  cancelled: number
  dispatched: number
  pending: number
  reserved: number
  on_pick_list: number
  available_for_dispatch: number
  production_open: number
  produced: number
  to_produce: number
  production_orders: { id: string; production_order_number: string; status: string; planned_quantity: number; completed_quantity: number }[]
  unit_price: number | null
  discount_percent: number | null
  discount_amount: number
  gst_rate: number | null
  taxable_value: number
  gst_amount: number
  line_total: number
  bom: { id: string; bom_code: string; version: number } | null
  materials: SoV2Material[]
  material_short: boolean
}

export interface SoV2Shortage {
  product_id: string
  sku: string
  product_name: string
  product_type: string
  unit: string
  required: number
  reserved: number
  available: number
  shortage: number
  recommended_purchase: number
  preferred_supplier_id: string | null
  preferred_supplier_name: string | null
  hsn_code: string | null
  gst_rate: number | null
  standard_cost: number | null
}

export interface SoV2Summary {
  sales_order_id: string
  sales_order_number: string
  status: SoV2Status
  order_status: string
  customer_id: string | null
  customer_name: string
  customer_gstin: string | null
  grand_total: number
  lines: SoV2Line[]
  shortages: SoV2Shortage[]
  warnings: string[]
}

export interface SoV2Dispatch {
  fulfilment_id: string
  fulfilment_number: string
  status: string
  dispatched_at: string | null
  created_at: string
  vehicle_number: string | null
  lr_number: string | null
  cancel_reason: string | null
  invoiced: boolean
  lines: { sku: string; unit: string; quantity: number; quantity_to_pick: number; transaction_number: string | null }[]
}

export interface SoV2Event { id: string; event_type: string; from_status: string | null; to_status: string | null; note: string | null; details: Record<string, unknown>; created_at: string; actor_user_id: string | null }

export type SoV2Detail = SoV2Summary & { dispatches: SoV2Dispatch[]; history: SoV2Event[] }

export interface SoV2LineInput {
  line_id?: string | null
  product_id: string
  description?: string | null
  quantity: string
  unit_price?: string | null
  discount_percent?: string | null
  discount_amount?: string | null
  gst_rate?: string | null
}

export interface SoV2Header {
  customer_id: string
  order_date?: string
  customer_gstin?: string | null
  billing_address?: string | null
  shipping_address?: string | null
  requested_delivery_date?: string | null
  payment_terms?: string | null
  delivery_instructions?: string | null
  customer_reference?: string | null
  customer_po_number?: string | null
  internal_notes?: string | null
  warehouse_id?: string | null
  freight_amount?: string
  other_charges_amount?: string
  charges_gst_rate?: string
  draft?: boolean
  correction_reason?: string | null
}

export type SoV2SaveResult = SoV2Summary & { changes?: unknown[] }

export type SalesOrderV2Header = SalesOrderListRow & {
  customer_gstin_snapshot: string | null
  payment_terms: string | null
  delivery_instructions: string | null
  freight_amount: number
  other_charges_amount: number
  charges_gst_rate: number
  tax_treatment: 'INTRA_STATE' | 'INTER_STATE' | null
  gross_total: number
  discount_total: number
  taxable_total: number
  cgst_total: number
  sgst_total: number
  igst_total: number
  grand_total: number
}

export async function fetchSalesOrderHeader(id: string): Promise<SalesOrderV2Header> {
  const { data, error } = await requireSupabase().from('sales_order_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as unknown as SalesOrderV2Header
}

export async function fetchSalesOrderLinesV2(id: string): Promise<(SalesOrderLineListRow & { description: string | null; discount_percent: number | null; discount_amount: number; gst_rate: number | null })[]> {
  const { data, error } = await requireSupabase().from('sales_order_line_list').select('*').eq('sales_order_id', id).order('line_no')
  if (error) throw error
  return (data ?? []) as never
}

export async function fetchCompanyGstin(): Promise<string | null> {
  const r = await requireSupabase().from('companies').select('gstin').limit(1).maybeSingle()
  return r.error ? null : ((r.data as { gstin: string | null } | null)?.gstin ?? null)
}

export const saveSalesOrderV2 =(soId: string | null, header: SoV2Header, lines: SoV2LineInput[], key: string | null) =>
  rpc<SoV2SaveResult>('sales_order_v2_save', { p_so_id: soId, p_header: header, p_lines: lines, p_idempotency_key: key })

export const fetchSalesOrderV2 = (soId: string) => rpc<SoV2Detail>('sales_order_v2_summary', { p_so_id: soId })

/**
 * Sales order invoicing (migration 20261115090000): ordered, posted-invoiced, released and
 * pending invoice quantities per order line, plus the partial-invoice and release reports.
 * Pending quantities are tracking figures, never stock.
 */
export const fetchInvoiceTracking = (filters: Record<string, string | boolean | null | undefined> = {}) =>
  rpc<import('@/features/sales/pending-invoice-model').TrackingResult>('sales_invoice_tracking', {
    p_filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
  })

/** Releases a pending (uninvoiced) quantity of an order line: no stock movement, reservation freed, audited, Super Admins notified. */
export const releasePendingQuantity = (lineId: string, quantity: number, reason: string, key: string) =>
  rpc<{ line_id: string; released: number; pending: number; status: string; reservation_released: number | null }>('sales_order_line_release_pending',
    { p_line_id: lineId, p_quantity: quantity, p_reason: reason, p_idempotency_key: key })
export const reserveSalesOrderV2 = (soId: string) => rpc<SoV2Summary>('sales_order_v2_reserve', { p_so_id: soId })
export const releaseSalesOrderV2 = (soId: string, reason: string | null) =>
  rpc<SoV2Summary & { finished_goods_released: number; materials_released: number }>('sales_order_v2_release', { p_so_id: soId, p_reason: reason })

export const createProductionFromSo = (soId: string, lineId: string | null, key: string) =>
  rpc<{ created: { line_no: number; sku: string; quantity: number; unit: string; order_id: string; production_order_number: string }[]; skipped: { line_no: number; sku: string; reason: string }[]; status: SoV2Status }>(
    'sales_order_v2_create_production', { p_so_id: soId, p_line_id: lineId, p_idempotency_key: key })

export const dispatchSalesOrderV2 = (soId: string, lines: { line_id: string; quantity: string }[], details: Record<string, string | null>, key: string) =>
  rpc<{ dispatches: { fulfilment_id: string; fulfilment_number: string; quantity: number }[]; transaction_numbers: string[]; dispatched_quantity: number; status: SoV2Status }>(
    'sales_order_v2_dispatch', { p_so_id: soId, p_lines: lines, p_details: details, p_idempotency_key: key })

export const reverseDispatchV2 = (fulfilmentId: string, reason: string, key: string) =>
  rpc<{ reversal_numbers: string[]; quantity: number; status: SoV2Status }>('sales_order_v2_reverse_dispatch', { p_fulfilment_id: fulfilmentId, p_reason: reason, p_idempotency_key: key })

export const cancelSalesOrderV2 = (soId: string, reason: string, key: string) =>
  rpc<{ status: string; released_quantity: number; materials_released: number; warnings: string[] }>('sales_order_v2_cancel', { p_so_id: soId, p_reason: reason, p_idempotency_key: key })

export interface SoV2ListRow {
  id: string
  sales_order_number: string
  order_date: string
  customer_id: string | null
  customer_name: string
  customer_reference: string | null
  requested_delivery_date: string | null
  grand_total: number
  status: SoV2Status
  order_status: string
  created_at: string
  units: { unit: string; ordered: number; dispatched: number; reserved: number }[] | null
}

export const fetchSalesOrdersV2 = (from: string | null, to: string | null, customerId: string | null, status: string | null) =>
  rpc<SoV2ListRow[]>('sales_orders_v2_list', { p_from: from, p_to: to, p_customer_id: customerId, p_status: status })

export interface SalesDashboard {
  from: string
  to: string
  today: string
  total_orders: number
  created_today: number
  this_month: number
  total_value: number
  pending: number
  partially_fulfilled: number
  fully_fulfilled: number
  cancelled: number
  awaiting_dispatch: number
  by_status: Partial<Record<SoV2Status, number>>
  finished_goods_reserved: UnitQty[]
  production_required: (UnitQty & { in_production: number })[]
  ordered: { unit: string; ordered: number; dispatched: number; pending: number }[]
  shortages: { product_id: string; sku: string; product_name: string; unit: string; required: number; reserved: number; available: number; shortage: number; preferred_supplier_name: string | null; orders: number }[]
  recent: { id: string; sales_order_number: string; order_date: string; customer_name: string; grand_total: number; status: SoV2Status; created_at: string }[]
}

export const fetchSalesDashboard = (from: string, to: string, customerId: string | null, status: string | null) =>
  rpc<SalesDashboard>('sales_dashboard', { p_from: from, p_to: to, p_customer_id: customerId, p_status: status })

export interface SalesImportPreview {
  orders: (ImportGroup & { customer_id: string | null; customer_code: string | null; expected_delivery_date: string | null })[]
  rows: number
  valid: number
  warnings: number
  errors: number
  missing_customers: { name: string }[]
  missing_products: { sku: string; name: string | null }[]
}

export const previewSalesImport = (rows: SalesImportRow[], warehouseId: string | null) =>
  rpc<SalesImportPreview>('sales_order_import_preview', { p_rows: rows, p_warehouse_id: warehouseId })

export interface SalesImportResult {
  job_id: string
  created: { first_row: number; customer_reference: string; sales_order_id: string; sales_order_number: string; status: SoV2Status; grand_total: number }[]
  failed: { first_row: number; customer_reference: string | null; messages: string[] }[]
  created_count: number
  failed_count: number
}

export const runSalesImport = (rows: SalesImportRow[], warehouseId: string | null, file: { file_name: string }, key: string) =>
  rpc<SalesImportResult>('sales_order_import', { p_rows: rows, p_warehouse_id: warehouseId, p_file: file, p_idempotency_key: key })
