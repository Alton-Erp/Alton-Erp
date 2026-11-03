import { requireSupabase } from '@/lib/supabase'

/**
 * Phase 9 analytics. Every figure is aggregated in the database by
 * permission-checked, company-scoped functions
 * (supabase/migrations/20261017090000_executive_analytics.sql); the browser
 * never sums transactions itself. Sections the user may not see arrive as
 * { available: false, reason }.
 */

const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export type Unavailable = { available: false; reason: string }
export type Section<T> = ({ available: true } & T) | Unavailable
export const isAvailable = <T,>(s: Section<T> | null | undefined): s is { available: true } & T => Boolean(s && s.available)

export type UnitQty = { unit: string; quantity: number }

export interface AnalyticsContext {
  company: { legal_name: string; display_name: string; currency_code: string }
  timezone: string
  today: string
  fy_start_month: number
  /** Company setting reporting.default_period (Phase 10); 'this_month' when not set. */
  default_period?: string
  access: Record<'sales' | 'fulfilment' | 'billing' | 'payments' | 'inventory' | 'valuation' | 'production' | 'outsourcing' | 'purchase_orders' | 'shortages' | 'data_quality', boolean>
  export: Record<'sales' | 'billing' | 'inventory' | 'production' | 'purchase_orders' | 'data_quality', boolean>
  warehouses: { id: string; code: string; name: string }[]
  categories: { id: string; name: string }[]
  generated_at: string
}

export interface SalesKpis {
  has_records: boolean
  orders_created: number
  order_value: number
  unpriced_order_lines: number
  other_currency_lines: number
  dispatched_value: number
  unpriced_dispatch_lines: number
  quantity_dispatched: UnitQty[]
  dispatches_completed: number
  orders_awaiting_fulfilment: number
  orders_with_shortages: number
  partially_fulfilled: number
}
export interface BillingKpis {
  has_records: boolean
  invoices_issued: number
  invoiced_total: number
  invoiced_taxable: number
  credit_notes_total: number
  debit_notes_total: number
  payments_received: number
  receipts_count: number
  outstanding: number
  customer_credits: number
  overdue: number
  overdue_invoices: number
  partially_paid: number
  open_invoices: number
  unallocated_receipts: number
  unallocated_receipts_count: number
}
export interface StockUnits {
  unit: string
  on_hand: number
  reserved: number
  available: number
  in_house: number
  outsourced: number
  unknown: number
  quarantine: number
  rejected: number
  external: number
}
export interface InventoryKpis {
  has_records: boolean
  active_products: number
  low_stock_products: number
  out_of_stock_products: number
  fully_reserved_products: number
  never_stocked_products: number
  shortage_products: number
  shortage_units: UnitQty[]
  units: StockUnits[]
  by_warehouse: { warehouse_id: string; warehouse_code: string; warehouse_name: string; unit: string; on_hand: number; available: number }[]
}
export interface Valuation {
  method: string
  lots: number
  costed_lots: number
  uncosted: UnitQty[]
  complete: boolean
  value: number | null
  costed_value: number | null
  available: boolean
  reason: string | null
}
export interface ProductionKpis {
  has_records: boolean
  orders_created: number
  orders_in_progress: number
  orders_completed: number
  orders_due: number
  orders_due_completed: number
  completion_rate: number | null
  planned_vs_actual: { unit: string; planned: number; good: number; rejected: number; scrap: number }[]
  output_in_period: { unit: string; good: number; rejected: number; scrap: number }[]
  material_shortages: number
  delayed_orders: number
  outsourcing: Section<{ in_progress: number; awaiting_receipt: UnitQty[]; overdue: number; received_in_period: { unit: string; accepted: number; rejected: number }[] }>
}
export interface ExecutiveData {
  from: string
  to: string
  as_of: string
  today: string
  timezone: string
  currency: string
  sales: Section<SalesKpis>
  billing: Section<BillingKpis>
  inventory: Section<InventoryKpis>
  valuation: Valuation | Unavailable
  production: Section<ProductionKpis>
  generated_at: string
}

export interface CommonFilters {
  from: string
  to: string
  asOf?: string | null
  warehouseId?: string | null
  categoryId?: string | null
}

export const fetchAnalyticsContext = () => rpc<AnalyticsContext>('analytics_context', {})
export const fetchExecutive = (f: CommonFilters) =>
  rpc<ExecutiveData>('analytics_executive', { p_from: f.from, p_to: f.to, p_as_of: f.asOf ?? null, p_warehouse_id: f.warehouseId ?? null, p_category_id: f.categoryId ?? null })

export interface SalesMonth { month: string; order_value: number; orders: number; dispatched_value: number; invoiced_value: number | null; credit_notes: number | null; debit_notes: number | null }
export interface CustomerValue { customer_id: string | null; customer_key?: string; customer: string; value: number; orders?: number; dispatches?: number }
export interface OpenLine {
  sales_order_id: string; sales_order_number: string; customer: string; customer_po_number: string | null; order_status: string; sku: string; product_name: string
  unit: string; ordered: number; dispatched: number; remaining: number; reserved: number; available_now: number; shortage: number
}
export interface SalesAnalytics {
  from: string
  to: string
  bucket: string
  currency: string
  has_records: boolean
  invoices_available: boolean
  totals: { orders: number; order_value: number; unpriced_order_lines: number; dispatched_value: number; unpriced_dispatch_lines: number; dispatches: number; invoiced_value: number | null; credit_notes: number | null; debit_notes: number | null }
  monthly: SalesMonth[]
  trend: { bucket: string; orders: number; order_value: number }[]
  top_customers_ordered: CustomerValue[]
  top_customers_dispatched: CustomerValue[]
  top_customers_invoiced: CustomerValue[] | null
  by_product: { product_id: string; sku: string; product_name: string; unit: string; ordered: number; order_value: number; dispatched: number; dispatched_value: number }[]
  by_category: { category_id: string | null; category: string; order_value: number; dispatched_value: number }[]
  salesperson: Unavailable
  fulfilment: { orders: number; fully_dispatched: number; partially_dispatched: number; not_dispatched: number; order_rate: number | null; units: { unit: string; ordered: number; dispatched: number; rate: number | null }[] }
  open_lines: { lines: number; short_lines: number; orders_short: number; by_unit: { unit: string; remaining: number; reserved: number; shortage: number }[]; rows: OpenLine[] }
  generated_at: string
}
export interface SalesFilters extends CommonFilters { customerId?: string | null; productId?: string | null; orderStatus?: string | null; bucket: 'day' | 'week' | 'month' }
export const fetchSalesAnalytics = (f: SalesFilters) =>
  rpc<SalesAnalytics>('analytics_sales', {
    p_from: f.from, p_to: f.to, p_customer_id: f.customerId ?? null, p_category_id: f.categoryId ?? null, p_product_id: f.productId ?? null,
    p_warehouse_id: f.warehouseId ?? null, p_order_status: f.orderStatus ?? null, p_bucket: f.bucket,
  })

export interface InventoryAnalytics {
  from: string
  to: string
  bucket: string
  today: string
  has_records: boolean
  current: {
    by_warehouse: { warehouse_id: string; warehouse: string; warehouse_name: string; unit: string; on_hand: number; reserved: number; available: number }[]
    by_category: { category_id: string | null; category: string; unit: string; on_hand: number; available: number }[]
    by_source: { unit: string; in_house: number; outsourced: number; unknown: number; in_house_available: number; outsourced_available: number }[]
    by_usage: { unit: string; usage: string; on_hand: number }[]
    top_available: { product_id: string; sku: string; product_name: string; unit: string; available: number; reserved: number }[]
    below_reorder_count: number
    below_reorder: { product_id: string; sku: string; product_name: string; unit: string; available: number; reorder_level: number; gap: number }[]
    zero_stock_count: number
    zero_stock: { product_id: string; sku: string; product_name: string; unit: string; storage_on_hand: number; reserved: number; has_history: boolean }[]
    reservation_utilisation: { unit: string; storage_on_hand: number; reserved: number; percent: number | null }[]
    reservations_by_type: { reference_type: string; unit: string; quantity: number; reservations: number }[]
    expiry: { expired: { unit: string; quantity: number; lots: number }[]; expiring_30: { unit: string; quantity: number; lots: number }[]; lots: { product_id: string; sku: string; batch_number: string | null; expiry_date: string; unit: string; on_hand: number; days_left: number }[] }
  }
  period: {
    balances: { unit: string; opening: number; closing: number; net_change: number }[]
    trend: { bucket: string; unit: string; in: number; out: number }[]
    by_type: { transaction_type: string; unit: string; in: number; out: number; transactions: number }[]
    transfers: { count: number; between_warehouses: number; routes: { from: string; to: string; unit: string; quantity: number; transfers: number }[] }
    adjustments: { posted: number; pending_approval: number; by_reason: { reason_code: string; unit: string; adjustments: number; increase: number; decrease: number }[] }
    counts: { posted_counts: number; lines_counted: number; lines_with_variance: number; pending_review: number; by_unit: { unit: string; surplus: number; shortfall: number }[]; rows: { count_id: string; count_number: string; sku: string; unit: string; system_quantity: number; counted_quantity: number; variance: number }[] }
  }
  valuation: Valuation | Unavailable
  generated_at: string
}
export interface InventoryFilters extends CommonFilters { sourceType?: string | null; bucket: 'day' | 'week' | 'month' }
export const fetchInventoryAnalytics = (f: InventoryFilters) =>
  rpc<InventoryAnalytics>('analytics_inventory', { p_from: f.from, p_to: f.to, p_warehouse_id: f.warehouseId ?? null, p_category_id: f.categoryId ?? null, p_source_type: f.sourceType ?? null, p_bucket: f.bucket })

export interface ProductionAnalytics {
  from: string
  to: string
  today: string
  has_records: boolean
  by_status: { status: string; orders: number }[]
  orders_due: number
  orders_due_completed: number
  completion_rate: number | null
  planned_vs_actual: { unit: string; planned: number; good: number; rejected: number; scrap: number; rate: number | null }[]
  due_orders: { order_id: string; order_number: string; sku: string; unit: string; status: string; target_date: string; planned: number; good: number }[]
  output: { unit: string; good: number; rejected: number; scrap: number }[]
  output_by_month: { month: string; unit: string; good: number; rejected: number; scrap: number }[]
  material_outlook: { product_id: string; sku: string; product_name: string; unit: string; warehouse: string; orders: number; outstanding: number; reserved_for_orders: number; available: number; shortage: number; order_numbers: string }[]
  shortage_materials: number
  consumption_by_order: { order_id: string; order_number: string; product_sku: string; unit: string; quantity: number; planned: number; issues: number }[]
  overdue_orders: { order_id: string; order_number: string; sku: string; status: string; unit: string; target_date: string; days_late: number; planned: number; good: number }[]
  overdue_count: number
  outsourcing: Section<{
    by_status: { status: string; orders: number }[]
    held_by_suppliers: { supplier: string; sku: string; unit: string; quantity: number }[]
    external_stock: { unit: string; on_hand: number }[]
    flows: { unit: string; dispatched: number; returned: number }[]
    received: { unit: string; received: number; accepted: number; rejected: number }[]
    awaiting_receipt: UnitQty[]
    lead_time: { orders: number; average_days: number | null; definition: string }
    overdue: { order_id: string; order_number: string; supplier: string; sku: string; status: string; expected_return_date: string; days_late: number; unit: string; outstanding: number }[]
    suppliers: string[]
  }>
  generated_at: string
}
export interface ProductionFilters extends CommonFilters { productId?: string | null; supplier?: string | null; orderId?: string | null }
export const fetchProductionAnalytics = (f: ProductionFilters) =>
  rpc<ProductionAnalytics>('analytics_production', { p_from: f.from, p_to: f.to, p_warehouse_id: f.warehouseId ?? null, p_product_id: f.productId ?? null, p_supplier: f.supplier ?? null, p_order_id: f.orderId ?? null })

export interface FulfilmentAnalytics {
  from: string
  to: string
  purchase_orders: Section<{ has_records: boolean; imported: number; awaiting_validation: number; unresolved_mappings: number; ready_for_fulfilment: number; partially_allocated: number; fully_allocated: number; with_shortages: number; converted_to_sales_orders: number; by_status: { status: string; count: number }[] }>
  sales_orders: Section<{
    has_records: boolean; awaiting_confirmation: number; awaiting_allocation: number; awaiting_picking: number; awaiting_packing: number; awaiting_dispatch: number
    partially_dispatched: number; on_hold: number; completed_in_period: number; orders_in_period: number; fully_dispatched_in_period: number; fulfilment_rate: number | null
    units: { unit: string; ordered: number; dispatched: number; rate: number | null }[]; by_status: { status: string; count: number }[]
  }>
  generated_at: string
}
export const fetchFulfilmentAnalytics = (f: CommonFilters & { customerKey?: string | null }) =>
  rpc<FulfilmentAnalytics>('analytics_fulfilment', { p_from: f.from, p_to: f.to, p_customer_key: f.customerKey ?? null, p_warehouse_id: f.warehouseId ?? null })

export interface ShortageRow {
  source: 'SALES_ORDER' | 'CUSTOMER_PO'; customer_po_number: string | null; sales_order_number: string | null; sales_order_id: string | null; purchase_order_id: string | null
  customer: string; product_id: string; sku: string; product_name: string; unit: string; ordered: number; dispatched: number; reserved: number; available: number
  remaining_required: number; shortage: number; in_house: number; outsourced: number; next_action: string
}
export interface ShortageReport {
  available: true
  sources: { sales_orders: boolean; purchase_orders: boolean }
  total: number
  rows: ShortageRow[]
  product_totals: { product_id: string; sku: string; product_name: string; unit: string; required: number; available: number; net_shortage: number; lines: number }[]
  definition: string
  generated_at: string
}
export const fetchShortages = (f: { customerKey?: string | null; warehouseId?: string | null; productId?: string | null; onlyShort: boolean; limit: number; offset: number }) =>
  rpc<ShortageReport>('analytics_shortages', { p_customer_key: f.customerKey ?? null, p_warehouse_id: f.warehouseId ?? null, p_product_id: f.productId ?? null, p_only_short: f.onlyShort, p_limit: f.limit, p_offset: f.offset })

export interface FinanceAnalytics {
  from: string
  to: string
  as_of: string
  currency: string
  has_records: boolean
  totals: { invoices: number; invoiced: number; invoiced_taxable: number; collected: number; receipts: number; reversed_receipts: number; allocated_in_period: number; outstanding: number; overdue: number; customer_credits: number; credit_notes: number; debit_notes: number; unallocated: number }
  collection_rate: { allocated: number; open_at_end: number; percent: number | null; definition: string }
  collection_time: { invoices: number; average_days: number | null; definition: string }
  monthly: { month: string; invoiced: number; invoices: number; collected: number; credit_notes: number; debit_notes: number }[]
  ageing: { bucket: string; amount: number; invoices: number }[]
  by_customer: { customer_id: string; customer: string; balance: number; overdue: number; invoices: number; oldest_days_overdue: number }[]
  customers_with_balance: number
  top_overdue: { customer_id: string; customer: string; overdue: number; invoices: number; oldest_days_overdue: number }[]
  upcoming_due: { invoice_id: string; invoice_number: string; customer: string; due_date: string; balance: number; days_to_due: number }[]
  upcoming_due_total: number
  notes_by_reason: { note_type: string; reason_code: string; notes: number; total: number }[]
  unallocated_receipts: { payment_id: string; receipt_number: string; receipt_date: string; customer: string; amount: number; unallocated: number }[] | null
  unavailable_metrics: { metric: string; reason: string }[]
  generated_at: string
}
export const fetchFinanceAnalytics = (f: CommonFilters & { customerId?: string | null }) =>
  rpc<FinanceAnalytics>('analytics_finance', { p_from: f.from, p_to: f.to, p_as_of: f.asOf ?? null, p_customer_id: f.customerId ?? null })

export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export interface ExecutiveAlert {
  id: string; type: string; severity: AlertSeverity; team: string; title: string; reference: string; record_id: string | null
  detected_at: string; explanation: string; action: string; link: string
}
export interface AlertsResult { as_of: string; today: string; alerts: ExecutiveAlert[]; limit_per_rule: number; skipped: string[]; counts: Partial<Record<AlertSeverity, number>>; generated_at: string }
export const fetchAlerts = (asOf: string | null) => rpc<AlertsResult>('analytics_alerts', { p_as_of: asOf })

export interface DataQualityCheck { code: string; module: string; title: string; rule: string; issues: number; samples: { reference: string; record_id: string | null; link: string; detail: string }[] }
export interface DataQualityResult { checks: DataQualityCheck[]; issues: number; note: string; generated_at: string }
export const fetchDataQuality = () => rpc<DataQualityResult>('analytics_data_quality', {})

// ---------------------------------------------------------------------------
// Drill-downs: page through the authorised source records (RLS applies).
// ---------------------------------------------------------------------------
export type DrillSource = 'sales_orders' | 'dispatches' | 'invoices' | 'receipts' | 'stock'
export interface DrillSpec {
  source: DrillSource
  title: string
  from?: string | null
  to?: string | null
  /** Day boundaries as instants in the company time zone (for timestamp columns). */
  fromInstant?: string | null
  toInstant?: string | null
  customerId?: string | null
  customerKey?: string | null
  warehouseId?: string | null
  categoryId?: string | null
  productId?: string | null
  sourceType?: string | null
  overdueOnly?: boolean
}

const DRILL_VIEW: Record<DrillSource, string> = {
  sales_orders: 'sales_order_list',
  dispatches: 'fulfilment_list',
  invoices: 'sales_invoice_list',
  receipts: 'customer_payment_list',
  stock: 'inventory_stock_detail',
}

interface LooseQuery extends PromiseLike<{ data: unknown[] | null; error: unknown; count: number | null }> {
  eq(column: string, value: unknown): LooseQuery
  gte(column: string, value: unknown): LooseQuery
  lte(column: string, value: unknown): LooseQuery
  lt(column: string, value: unknown): LooseQuery
  not(column: string, operator: string, value: unknown): LooseQuery
  order(column: string, options?: { ascending: boolean }): LooseQuery
  range(from: number, to: number): LooseQuery
}

export async function fetchDrilldown(spec: DrillSpec, page: number, pageSize: number): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  // One builder for several views; the column names are checked by the tests against the views.
  let q = (db().from(DRILL_VIEW[spec.source] as 'sales_order_list') as unknown as { select: (c: string, o: { count: 'exact' }) => LooseQuery }).select('*', { count: 'exact' })
  const eq = (col: string, v: string | null | undefined) => { if (v) q = q.eq(col, v) }
  switch (spec.source) {
    case 'sales_orders':
      q = q.not('order_status', 'in', '(CANCELLED,DRAFT)')
      if (spec.from) q = q.gte('order_date', spec.from)
      if (spec.to) q = q.lte('order_date', spec.to)
      eq('customer_id', spec.customerId); eq('customer_key', spec.customerKey); eq('warehouse_id', spec.warehouseId)
      q = q.order('order_date', { ascending: false })
      break
    case 'dispatches':
      q = q.not('actual_dispatch_at', 'is', null)
      if (spec.fromInstant) q = q.gte('actual_dispatch_at', spec.fromInstant)
      if (spec.toInstant) q = q.lt('actual_dispatch_at', spec.toInstant)
      eq('customer_id', spec.customerId); eq('customer_key', spec.customerKey); eq('warehouse_id', spec.warehouseId)
      q = q.order('actual_dispatch_at', { ascending: false })
      break
    case 'invoices':
      q = q.eq('status', 'ISSUED')
      if (spec.from) q = q.gte('invoice_date', spec.from)
      if (spec.to) q = q.lte('invoice_date', spec.to)
      if (spec.overdueOnly) q = q.eq('display_status', 'OVERDUE')
      eq('customer_id', spec.customerId)
      q = q.order('invoice_date', { ascending: false })
      break
    case 'receipts':
      q = q.eq('status', 'RECORDED')
      if (spec.from) q = q.gte('receipt_date', spec.from)
      if (spec.to) q = q.lte('receipt_date', spec.to)
      eq('customer_id', spec.customerId)
      q = q.order('receipt_date', { ascending: false })
      break
    case 'stock':
      eq('warehouse_id', spec.warehouseId); eq('category_id', spec.categoryId); eq('product_id', spec.productId); eq('source_type', spec.sourceType)
      q = q.order('sku').order('warehouse_code')
      break
  }
  const from = page * pageSize
  const { data, error, count } = await q.range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: (data ?? []) as Record<string, unknown>[], total: count ?? 0 }
}
