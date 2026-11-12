/**
 * Every clickable dashboard figure: which records it counts and where they are listed.
 *
 * Each entry repeats the database definition of the figure (see the dashboard functions named
 * in `basis`) as conditions on the list's own view, so the number on the card and the number of
 * records on the drill-down page come from the same rule. tests/db/drilldown-consistency-check.mjs
 * runs every entry against the database and compares it with the dashboard function.
 *
 * Pure module (no app imports): also loaded by the Node database check.
 */
import {
  and, anyGt, between, dayBetween, eq, gt, isFalse, isIn, isNull, isTrue, lt, neq, notIn, or, productIs,
  type Condition,
} from './drill-conditions.ts'

// ---------------------------------------------------------------------------
// Context carried from the dashboard (also the URL of the drill-down page)
// ---------------------------------------------------------------------------
export interface DrillContext {
  /** Dashboard period (inclusive). */
  from: string
  to: string
  /** Company date and time zone the dashboard used. */
  today: string
  tz: string
  /** Dashboard filters. */
  customer?: string | null
  status?: string | null
  payment?: string | null
  /** Unit of a quantity figure (quantities are never added across units). */
  unit?: string | null
  /** Chart segment: a label (category, warehouse, supplier) or a date range (segFrom..segTo). */
  segment?: string | null
  segFrom?: string | null
  segTo?: string | null
}

const PARAMS: [keyof DrillContext, string][] = [
  ['from', 'from'], ['to', 'to'], ['today', 'today'], ['tz', 'tz'], ['customer', 'customer'], ['status', 'status'],
  ['payment', 'payment'], ['unit', 'unit'], ['segment', 'seg'], ['segFrom', 'sf'], ['segTo', 'st'],
]

export function contextToParams(ctx: DrillContext): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, name] of PARAMS) {
    const v = ctx[k]
    if (v !== null && v !== undefined && v !== '') p.set(name, String(v))
  }
  return p
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reads the context from a URL; invalid values are dropped (never sent to the database as-is). */
export function contextFromParams(p: URLSearchParams, fallback: { today: string; tz: string }): DrillContext {
  // A real calendar date (2026-13-99 or 2026-02-30 is dropped).
  const date = (name: string) => { const v = p.get(name); if (!v || !DATE.test(v)) return null; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : null }
  const text = (name: string, max = 120) => { const v = p.get(name); return v && v.length <= max ? v : null }
  const tz = text('tz', 64)
  const today = date('today') ?? fallback.today
  const from = date('from') ?? monthStart(today)
  const to = date('to') ?? today
  const customer = text('customer', 40)
  return {
    from: from <= to ? from : to, to: from <= to ? to : from, today,
    tz: tz && /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(tz) ? tz : fallback.tz,
    customer: customer && UUID.test(customer) ? customer : null,
    status: text('status', 40), payment: text('payment', 40), unit: text('unit', 20), segment: text('seg'),
    segFrom: date('sf'), segTo: date('st'),
  }
}

export const monthStart = (date: string) => `${date.slice(0, 8)}01`

const shift = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
/** Last day of the month of a date. */
export const monthEnd = (date: string) => { const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10) }

/**
 * Dates covered by one chart bucket (date_trunc start), clipped to the dashboard period when given,
 * as the database counts it.
 */
export function bucketRange(start: string, bucket: 'day' | 'week' | 'month' | 'year', clip?: { from: string; to: string }): { segFrom: string; segTo: string } {
  const end = bucket === 'day' ? start : bucket === 'week' ? shift(start, 6) : bucket === 'month' ? monthEnd(start) : `${start.slice(0, 4)}-12-31`
  return { segFrom: clip && start < clip.from ? clip.from : start, segTo: clip && end > clip.to ? clip.to : end }
}

/** Stock health groups of the Inventory Overview (segment of inventory.health). */
export const STOCK_HEALTH = ['HEALTHY', 'LOW_STOCK', 'FULLY_RESERVED', 'OUT_OF_STOCK', 'NO_THRESHOLD', 'NEVER_STOCKED'] as const

// ---------------------------------------------------------------------------
// Sources: the lists the records are read from
// ---------------------------------------------------------------------------
export type SourceKey =
  | 'products' | 'product_stock' | 'product_stock_value' | 'stock_detail' | 'movements' | 'purchase_orders' | 'grns' | 'grn_lines'
  | 'production_orders' | 'production_outputs' | 'production_consumption' | 'invoices' | 'payments' | 'sales_orders_view'
  | 'sales_orders' | 'parties' | 'production_shortages' | 'sales_shortages'

export interface ViewSource {
  kind: 'view'
  relation: string
  /** Primary key of a row (for React keys and links). */
  id: string
  search: string[]
  sort: { column: string; ascending: boolean }
}
export interface RpcSource {
  kind: 'rpc'
  fn: string
  id: string
  search: string[]
  sort: { column: string; ascending: boolean }
  /** Path of the list inside the result (null: the result is the list). */
  path: string | null
}
export type DrillSource = ViewSource | RpcSource

export const SOURCES: Record<SourceKey, DrillSource> = {
  products: { kind: 'view', relation: 'products', id: 'id', search: ['sku', 'product_name', 'barcode', 'model_number'], sort: { column: 'sku', ascending: true } },
  product_stock: { kind: 'view', relation: 'inventory_product_stock', id: 'product_id', search: ['sku', 'product_name', 'barcode'], sort: { column: 'sku', ascending: true } },
  // inventory_product_stock plus its stock valuation (migration 20261125090000; the stock report rule).
  product_stock_value: { kind: 'view', relation: 'inventory_product_stock_value', id: 'product_id', search: ['sku', 'product_name', 'barcode'], sort: { column: 'sku', ascending: true } },
  stock_detail: { kind: 'view', relation: 'inventory_stock_detail', id: 'balance_id', search: ['sku', 'product_name', 'batch_number', 'location_code'], sort: { column: 'sku', ascending: true } },
  movements: { kind: 'view', relation: 'inventory_transaction_list', id: 'id', search: ['transaction_number', 'sku', 'product_name', 'reference_number'], sort: { column: 'transaction_date', ascending: false } },
  purchase_orders: { kind: 'view', relation: 'purchase_order_list_excl_gst', id: 'id', search: ['po_number', 'supplier_name', 'reference_number'], sort: { column: 'po_date', ascending: false } },
  grns: { kind: 'view', relation: 'goods_receipt_list_v2', id: 'id', search: ['receipt_number', 'po_number', 'supplier_name', 'supplier_document_number'], sort: { column: 'receipt_date', ascending: false } },
  grn_lines: { kind: 'view', relation: 'goods_receipt_line_list', id: 'id', search: ['receipt_number', 'sku', 'description'], sort: { column: 'receipt_date', ascending: false } },
  production_orders: { kind: 'view', relation: 'production_order_list', id: 'id', search: ['production_order_number', 'sku', 'product_name'], sort: { column: 'created_at', ascending: false } },
  production_outputs: { kind: 'view', relation: 'production_output_list', id: 'id', search: ['receipt_number', 'production_order_number', 'sku', 'product_name'], sort: { column: 'production_date', ascending: false } },
  production_consumption: { kind: 'view', relation: 'production_consumption_list', id: 'id', search: ['production_order_number', 'sku', 'product_name', 'transaction_number'], sort: { column: 'consumption_date', ascending: false } },
  invoices: { kind: 'view', relation: 'sales_invoice_list_excl_gst', id: 'id', search: ['invoice_number', 'proforma_number', 'customer_legal_name'], sort: { column: 'invoice_date', ascending: false } },
  payments: { kind: 'view', relation: 'customer_payment_list', id: 'id', search: ['receipt_number', 'customer_name', 'transaction_reference'], sort: { column: 'receipt_date', ascending: false } },
  sales_orders_view: { kind: 'view', relation: 'sales_order_list', id: 'id', search: ['sales_order_number', 'customer_name_snapshot', 'customer_reference'], sort: { column: 'order_date', ascending: false } },
  sales_orders: { kind: 'rpc', fn: 'sales_orders_v2_list_excl_gst', path: null, id: 'id', search: ['sales_order_number', 'customer_name', 'customer_reference'], sort: { column: 'order_date', ascending: false } },
  parties: { kind: 'rpc', fn: 'ledger_parties_excl_gst', path: null, id: 'party_id', search: ['party_name', 'party_code', 'gstin'], sort: { column: 'party_name', ascending: true } },
  production_shortages: { kind: 'rpc', fn: 'production_dashboard', path: 'shortages', id: 'component_product_id', search: ['sku', 'product_name'], sort: { column: 'sku', ascending: true } },
  sales_shortages: { kind: 'rpc', fn: 'sales_dashboard', path: 'shortages', id: 'product_id', search: ['sku', 'product_name'], sort: { column: 'sku', ascending: true } },
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------
export type DashboardKey = 'management' | 'products' | 'inventory' | 'purchase' | 'grn' | 'production' | 'sales' | 'billing' | 'ledger'
  // Module list pages with summary cards (a path segment ":segment" is replaced by the context's segment).
  | 'product_master' | 'purchase_orders' | 'goods_receipts' | 'ledger_list' | 'stock_card'
export const DASHBOARDS: Record<DashboardKey, { label: string; path: string; department: string }> = {
  management: { label: 'Management Dashboard', path: '/', department: 'Management' },
  products: { label: 'Product Dashboard', path: '/products/dashboard', department: 'Product Master' },
  inventory: { label: 'Inventory Overview', path: '/inventory', department: 'Inventory' },
  purchase: { label: 'Purchase Dashboard', path: '/purchase-orders/dashboard', department: 'Purchasing' },
  grn: { label: 'GRN Dashboard', path: '/goods-receipts/dashboard', department: 'Purchasing' },
  production: { label: 'Production Dashboard', path: '/production', department: 'Production' },
  sales: { label: 'Sales Dashboard', path: '/sales/dashboard', department: 'Sales' },
  billing: { label: 'Invoice Dashboard', path: '/billing/dashboard', department: 'Billing & GST' },
  ledger: { label: 'Ledger Dashboard', path: '/ledger/dashboard', department: 'Ledger' },
  product_master: { label: 'Product Master', path: '/products', department: 'Product Master' },
  purchase_orders: { label: 'Purchase Orders', path: '/purchase-orders', department: 'Purchasing' },
  goods_receipts: { label: 'Goods Received', path: '/goods-receipts', department: 'Purchasing' },
  ledger_list: { label: 'Customer & Supplier Ledger', path: '/ledger', department: 'Ledger' },
  stock_card: { label: 'Product stock', path: '/inventory/stock/:segment', department: 'Inventory' },
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export type Measure =
  | { kind: 'count' }
  /** Sum of the columns (added together per row); quantities are per unit. */
  | { kind: 'sum'; columns: string[]; format: 'money' | 'quantity'; unitColumn?: string }

export interface DrillMetric {
  key: string
  dashboard: DashboardKey
  label: string
  /** The rule, in words (shown on the drill-down page). */
  definition: string
  /** Any of these permissions opens the records (the dashboard function's own check). */
  permissions: string[]
  source: SourceKey
  conditions: (ctx: DrillContext) => Condition[]
  /** Arguments of an RPC source. */
  rpcArgs?: (ctx: DrillContext) => Record<string, unknown>
  measure: Measure
  /** Opens the Product Master list instead of the generic drill-down page. */
  target?: 'products'
  /** The figure uses these parts of the context. */
  uses?: ('period' | 'today' | 'unit' | 'segment' | 'segmentRange' | 'customer' | 'status' | 'payment')[]
  /** Dashboard function and field the figure comes from (database check). */
  basis: string
  /** Extra summary cards computed on the server (stock_value: inventory_stock_value_summary). */
  summary?: 'stock_value'
}

const COUNT: Measure = { kind: 'count' }
const money = (...columns: string[]): Measure => ({ kind: 'sum', columns, format: 'money' })
const qty = (column: string, unitColumn: string): Measure => ({ kind: 'sum', columns: [column], format: 'quantity', unitColumn })

const PO_OPEN = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED']
const PO_PLACED = [...PO_OPEN, 'RECEIVED', 'CLOSED']
const SO_PENDING = ['OPEN', 'PARTIALLY_RESERVED', 'STOCK_SHORTAGE', 'PRODUCTION_PENDING', 'READY_FOR_DISPATCH']
const SO_AWAITING = ['READY_FOR_DISPATCH', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RESERVED', 'PRODUCTION_PENDING', 'STOCK_SHORTAGE']
const SO_CLOSED = ['CANCELLED', 'FULLY_DISPATCHED', 'DRAFT']

const unitIs = (col: string) => (c: DrillContext): Condition[] => (c.unit ? [eq(col, c.unit)] : [])
const segRange = (c: DrillContext) => ({ from: c.segFrom ?? c.from, to: c.segTo ?? c.to })

// Products (module_dashboard 'PRODUCTS'): non-archived products.
const PRODUCTS = { dashboard: 'products' as const, permissions: ['products.read'], source: 'products' as const, target: 'products' as const, measure: COUNT }
const current = isNull('archived_at')

// Inventory (inventory_overview): one row per product in inventory_product_stock.
const INV = { dashboard: 'inventory' as const, permissions: ['inventory.read'], source: 'product_stock' as const }
const activeStock = [isNull('archived_at'), eq('product_status', 'ACTIVE')]
const unitQty = (column: string, label: string, key: string, definition: string): DrillMetric => ({
  ...INV, key, label, definition, uses: ['unit'], measure: qty(column, 'base_unit'), basis: `inventory_overview.units[unit].${key.split('.')[1]}`,
  conditions: (c) => [isNull('archived_at'), ...unitIs('base_unit')(c), neq(column, 0)],
})

// Purchase orders (purchase_order_dashboard / module_dashboard 'PURCHASE').
const PO = { dashboard: 'purchase' as const, permissions: ['purchases.read'], source: 'purchase_orders' as const }
// Goods receipts (module_dashboard 'GRN').
const GRN = { dashboard: 'grn' as const, permissions: ['purchases.read'], source: 'grns' as const, measure: COUNT }
const posted = eq('status', 'POSTED')
// Production (production_dashboard).
const PROD = { dashboard: 'production' as const, permissions: ['manufacturing.read'] }
// Sales (sales_dashboard): rows of sales_orders_v2_list with the status the database computes.
const SALES = { dashboard: 'sales' as const, permissions: ['sales_orders.read', 'fulfilment.read'], source: 'sales_orders' as const }
const salesArgs = (from: string | null, to: string | null) => (c: DrillContext) => ({ p_from: from, p_to: to, p_customer_id: c.customer ?? null, p_status: c.status ?? null })
const salesPeriod = (c: DrillContext) => salesArgs(c.from, c.to)(c)
// Invoices (invoice_dashboard): rows of sales_invoice_list.
const BILL = { dashboard: 'billing' as const, permissions: ['invoices.read', 'billing_reports.read'], source: 'invoices' as const }
const invBase = (c: DrillContext): Condition[] => [neq('status', 'DISCARDED'), ...(c.customer ? [eq('customer_id', c.customer)] : [])]
/** The dashboard's "invoice status" filter: PROFORMA, DRAFT (incl. pending approval) or the stored status. */
export const invoiceStatusIs = (s: string): Condition[] =>
  s === 'PROFORMA' ? [isTrue('is_proforma')] : s === 'DRAFT' ? [isFalse('is_proforma'), isIn('status', ['DRAFT', 'PENDING_APPROVAL'])] : [isFalse('is_proforma'), eq('status', s)]
/** The dashboard's "payment" filter: OVERDUE, or the payment status of an issued invoice that is not overdue. */
export const paymentStatusIs = (s: string): Condition[] =>
  s === 'OVERDUE' ? [eq('status', 'ISSUED'), eq('display_status', 'OVERDUE')]
    : [eq('status', 'ISSUED'), or(neq('display_status', 'OVERDUE'), isNull('display_status')), eq('payment_status', s)]
const invPeriod = (c: DrillContext): Condition[] => [
  ...invBase(c), ...between('invoice_date', c.from, c.to),
  ...(c.status ? invoiceStatusIs(c.status) : []), ...(c.payment ? paymentStatusIs(c.payment) : []),
]
const issued = eq('status', 'ISSUED')
const BILL_USES: DrillMetric['uses'] = ['period', 'customer', 'status', 'payment']
// Ledger (module_dashboard 'LEDGER'): rows of ledger_parties.
const LEDGER = { dashboard: 'ledger' as const, permissions: ['ledger.read'], source: 'parties' as const, rpcArgs: () => ({ p_search: null, p_type: null, p_status: null, p_party_id: null }) }

// Product Master list cards (product_kpis).
const PM = { dashboard: 'product_master' as const, permissions: ['products.read'], source: 'products' as const, target: 'products' as const, measure: COUNT }
/** product_kpis.incomplete: no HSN, GST rate or category, or no selling price (finished goods) / no cost (other types). */
export const MISSING_INFO: Condition[] = [or(isNull('hsn_code'), isNull('gst_rate'), isNull('category_id'),
  and(eq('product_type', 'FINISHED_GOOD'), isNull('selling_price')),
  and(neq('product_type', 'FINISHED_GOOD'), isNull('standard_cost'), isNull('standard_manufacturing_cost')))]
// Per-product stock card: the product's lots (inventory_stock_detail).
const LOTS = { dashboard: 'stock_card' as const, permissions: ['inventory.read'], source: 'stock_detail' as const, uses: ['segment' as const] }
/** Ledger list scope (/ledger/customers, /ledger/suppliers): parties of that side, incl. those that are both. */
const ledgerScope = (c: DrillContext): Condition[] => (c.segment === 'CUSTOMER' || c.segment === 'SUPPLIER' ? [isIn('party_type', [c.segment, 'BOTH'])] : [])

const list: DrillMetric[] = [
  // --- Product Master -------------------------------------------------------
  { ...PRODUCTS, key: 'products.total', label: 'Total Products', definition: 'All products that are not archived (active and inactive).', basis: 'module_dashboard(PRODUCTS).total',
    conditions: () => [current] },
  { ...PRODUCTS, key: 'products.finished_goods', label: 'Finished Goods', definition: 'Products of type Finished good, not archived.', basis: 'module_dashboard(PRODUCTS).finished_goods',
    conditions: () => [current, eq('product_type', 'FINISHED_GOOD')] },
  { ...PRODUCTS, key: 'products.raw_materials', label: 'Raw Materials', definition: 'Products of type Raw material, not archived.', basis: 'module_dashboard(PRODUCTS).raw_materials',
    conditions: () => [current, eq('product_type', 'RAW_MATERIAL')] },
  { ...PRODUCTS, key: 'products.components', label: 'Components', definition: 'Components and subassemblies, not archived.', basis: 'module_dashboard(PRODUCTS).components',
    conditions: () => [current, isIn('product_type', ['COMPONENT', 'SUBASSEMBLY'])] },
  { ...PRODUCTS, key: 'products.outsourced', label: 'Outsourced Parts', definition: 'Outsourced components and products sourced from outsourcing partners, not archived.', basis: 'module_dashboard(PRODUCTS).outsourced',
    conditions: () => [current, or(eq('product_type', 'OUTSOURCED_COMPONENT'), eq('default_source_type', 'OUTSOURCED'))] },
  { ...PRODUCTS, key: 'products.without_bom', label: 'Products Without BOM', definition: 'Active finished goods and subassemblies made in-house with no approved BOM.', basis: 'module_dashboard(PRODUCTS).without_bom',
    conditions: () => [current, eq('status', 'ACTIVE'), isIn('product_type', ['FINISHED_GOOD', 'SUBASSEMBLY']), neq('default_source_type', 'OUTSOURCED'), isFalse('has_bom')] },
  { ...PRODUCTS, key: 'products.added', label: 'Recently Added', definition: 'Products created in the selected period.', uses: ['period'], basis: 'module_dashboard(PRODUCTS).added_in_period',
    conditions: (c) => [current, dayBetween('created_at', c.from, c.to, c.tz)] },
  { dashboard: 'products', permissions: ['products.read'], source: 'product_stock', measure: COUNT, key: 'products.low_stock', label: 'Low Stock Products',
    definition: 'Active products at or below their reorder level, or out of stock after having had stock.', basis: 'module_dashboard(PRODUCTS).low_stock_count',
    conditions: () => [...activeStock, or(eq('stock_status', 'LOW_STOCK'), and(eq('stock_status', 'OUT_OF_STOCK'), isTrue('has_history')))] },

  // --- Inventory ------------------------------------------------------------
  { ...INV, key: 'inventory.active_products', label: 'Total Active Products', definition: 'Active products that are not archived.', measure: COUNT, basis: 'inventory_overview.active_products',
    conditions: () => activeStock },
  // "Total Stock" of the Management Dashboard: the same records, with each product's stock value.
  { ...unitQty('on_hand', 'Total Units on Hand', 'inventory.on_hand', 'Physical quantity in stock in every location, per product, with its value at average inventory cost.'),
    source: 'product_stock_value', summary: 'stock_value' },
  unitQty('reserved', 'Total Reserved Units', 'inventory.reserved', 'Quantity reserved for orders and not yet issued.'),
  unitQty('available', 'Total Available Units', 'inventory.available', 'On hand minus reserved, in storage locations.'),
  unitQty('in_house_on_hand', 'In-House Stock', 'inventory.in_house', 'Stock in lots made in-house.'),
  unitQty('outsourced_on_hand', 'Outsourced Stock', 'inventory.outsourced', 'Stock in lots from outsourcing partners.'),
  unitQty('unknown_source_on_hand', 'Source Not Recorded', 'inventory.unknown', 'Stock in lots with no source recorded.'),
  { ...INV, key: 'inventory.low_stock', label: 'Low-Stock Products', definition: 'Active products at or below their reorder level, or with all storage stock reserved.', measure: COUNT,
    basis: 'inventory_overview.low_stock + fully_reserved', conditions: () => [...activeStock, isIn('stock_status', ['LOW_STOCK', 'FULLY_RESERVED'])] },
  { ...INV, key: 'inventory.out_of_stock', label: 'Out-of-Stock Products', definition: 'Active products with no storage stock that have had stock before.', measure: COUNT,
    basis: 'inventory_overview.out_of_stock', conditions: () => [...activeStock, eq('stock_status', 'OUT_OF_STOCK'), isTrue('has_history')] },
  { ...INV, key: 'inventory.health', label: 'Stock Health', definition: 'Active products in the chosen stock status.', uses: ['segment'], measure: COUNT,
    basis: 'inventory_overview.healthy / low_stock / fully_reserved / out_of_stock / no_threshold / never_stocked',
    conditions: (c) => [...activeStock, ...(c.segment === 'NEVER_STOCKED' ? [eq('on_hand', 0), isFalse('has_history')]
      : c.segment === 'OUT_OF_STOCK' ? [eq('stock_status', 'OUT_OF_STOCK'), isTrue('has_history')] : [eq('stock_status', c.segment ?? '')])] },
  { ...INV, key: 'inventory.category', label: 'Stock by Category', definition: 'Products of the chosen category with stock on hand.', uses: ['unit', 'segment'], measure: qty('on_hand', 'base_unit'),
    basis: 'inventory_overview.by_category[category, unit].on_hand',
    conditions: (c) => [isNull('archived_at'), ...unitIs('base_unit')(c), neq('on_hand', 0), c.segment && c.segment !== 'Uncategorised' ? eq('category_name', c.segment) : isNull('category_id')] },
  { dashboard: 'inventory', permissions: ['inventory.read'], source: 'stock_detail', key: 'inventory.warehouse', label: 'Stock by Warehouse', uses: ['unit', 'segment'],
    definition: 'Stock lots in the chosen warehouse.', measure: qty('on_hand', 'base_unit'), basis: 'inventory_overview.by_warehouse[warehouse, unit].on_hand',
    conditions: (c) => [isFalse('product_archived'), eq('warehouse_code', c.segment ?? ''), ...unitIs('base_unit')(c), or(neq('on_hand', 0), neq('reserved', 0))] },
  { dashboard: 'inventory', permissions: ['inventory.read'], source: 'movements', key: 'inventory.movements', label: 'Stock Movements', uses: ['unit', 'segmentRange'],
    definition: 'Stock received and issued in the chosen period; transfers between locations are left out.', measure: COUNT, basis: 'inventory_movement_trend(bucket).transactions',
    conditions: (c) => {
      const r = segRange(c)
      return [dayBetween('transaction_date', r.from, r.to, c.tz), notIn('transaction_type', ['TRANSFER_OUT', 'TRANSFER_IN']),
        or(neq('transaction_type', 'REVERSAL'), isNull('transfer_group_id')), ...unitIs('unit')(c)]
    } },

  // --- Purchase -------------------------------------------------------------
  { ...PO, key: 'purchase.total', label: 'Total POs', definition: 'Every purchase order, in any status.', measure: COUNT, basis: 'purchase_order_dashboard.total', conditions: () => [] },
  { ...PO, key: 'purchase.open', label: 'Open POs', definition: 'Approved or sent orders and orders partly received.', measure: COUNT, basis: 'purchase_order_dashboard.open',
    conditions: () => [isIn('status', PO_OPEN)] },
  { ...PO, key: 'purchase.partial', label: 'Partially Received POs', definition: 'Orders with some goods received.', measure: COUNT, basis: 'module_dashboard(PURCHASE).partially_received',
    conditions: () => [eq('status', 'PARTIALLY_RECEIVED')] },
  { ...PO, key: 'purchase.received', label: 'Fully Received POs', definition: 'Orders received in full or closed.', measure: COUNT, basis: 'module_dashboard(PURCHASE).fully_received',
    conditions: () => [isIn('status', ['RECEIVED', 'CLOSED'])] },
  { ...PO, key: 'purchase.pending_value', label: 'Pending Purchase Value (Excl. GST)', definition: 'Taxable value still to be received on open orders (GST excluded).', measure: money('pending_taxable_value'),
    basis: 'purchase_order_dashboard.outstanding_receipt_value', conditions: () => [isIn('status', PO_OPEN)] },
  { ...PO, key: 'purchase.overdue', label: 'Overdue Deliveries', definition: 'Open orders whose expected delivery date has passed.', uses: ['today'], measure: COUNT,
    basis: 'purchase_order_dashboard.overdue', conditions: (c) => [isIn('status', PO_OPEN), lt('expected_delivery_date', c.today)] },
  { ...PO, key: 'purchase.period', label: 'Taxable Purchases', definition: 'Taxable value (GST excluded) of orders dated in the period that were approved (cancelled, draft and rejected orders left out).', uses: ['period'],
    measure: money('taxable_total'), basis: 'purchase_order_dashboard.period_value / period_orders',
    conditions: (c) => [...between('po_date', c.from, c.to), isIn('status', PO_PLACED)] },
  { ...PO, key: 'purchase.supplier', label: 'Orders by Supplier', definition: 'Approved orders of the chosen supplier dated in the period (value excl. GST).', uses: ['period', 'segment'],
    measure: money('taxable_total'), basis: 'module_dashboard(PURCHASE).top_suppliers[supplier]',
    conditions: (c) => [...between('po_date', c.from, c.to), isIn('status', PO_PLACED), eq('supplier_name', c.segment ?? '')] },
  { ...PO, key: 'purchase.created', label: 'Purchase Orders', definition: 'Orders dated in the period, in any status.', uses: ['period'], measure: COUNT,
    basis: 'management_overview.purchase.created', conditions: (c) => between('po_date', c.from, c.to) },
  { ...PO, key: 'purchase.month', label: 'Purchases Ordered', definition: 'Approved orders dated in the chosen month (value excl. GST).', uses: ['segmentRange'], measure: money('taxable_total'),
    basis: 'management_overview.purchase.monthly[month].ordered',
    conditions: (c) => { const r = segRange(c); return [...between('po_date', r.from, r.to), isIn('status', PO_PLACED)] } },

  // --- Goods received -------------------------------------------------------
  { ...GRN, key: 'grn.total', label: 'Total GRNs', definition: 'Posted goods receipts (reversed receipts are not counted).', basis: 'module_dashboard(GRN).total', conditions: () => [posted] },
  { ...GRN, key: 'grn.today', label: 'GRNs Today', definition: 'Posted goods receipts dated today.', uses: ['today'], basis: 'module_dashboard(GRN).today',
    conditions: (c) => [posted, eq('receipt_date', c.today)] },
  { ...GRN, key: 'grn.month', label: 'Monthly GRNs', definition: 'Posted goods receipts dated this calendar month.', uses: ['today'], basis: 'module_dashboard(GRN).month',
    conditions: (c) => [posted, ...between('receipt_date', monthStart(c.today), c.today)] },
  { ...GRN, key: 'grn.period', label: 'Received in Period', definition: 'Posted goods receipts dated in the period.', uses: ['period'], basis: 'module_dashboard(GRN).in_period',
    conditions: (c) => [posted, ...between('receipt_date', c.from, c.to)] },
  { ...GRN, key: 'grn.unlinked', label: 'Unlinked GRNs', definition: 'Posted goods receipts without a purchase order.', basis: 'module_dashboard(GRN).unlinked',
    conditions: () => [posted, eq('receipt_type', 'DIRECT')] },
  { ...PO, dashboard: 'grn', key: 'grn.pending', label: 'Pending Receipts', definition: 'Approved or sent orders and orders partly received (value still to receive, excl. GST).', measure: money('pending_taxable_value'),
    basis: 'module_dashboard(GRN).pending_orders / pending_value', conditions: () => [isIn('status', PO_OPEN)] },
  { dashboard: 'grn', permissions: ['purchases.read'], source: 'grn_lines', key: 'grn.rejected', label: 'Rejected Goods', definition: 'Receipt lines of posted receipts in the period with goods rejected.',
    uses: ['period', 'unit'], measure: qty('rejected_quantity', 'unit'), basis: 'module_dashboard(GRN).rejected',
    conditions: (c) => [eq('receipt_status', 'POSTED'), ...between('receipt_date', c.from, c.to), gt('rejected_quantity', 0), ...unitIs('unit')(c)] },
  { ...GRN, dashboard: 'management', key: 'grn.month_received', label: 'Purchases Received', definition: 'Posted goods receipts dated in the chosen month.', uses: ['segmentRange'],
    basis: 'management_overview.purchase.monthly[month].received (count of receipts)',
    conditions: (c) => { const r = segRange(c); return [posted, ...between('receipt_date', r.from, r.to)] } },

  // --- Production -----------------------------------------------------------
  { ...PROD, source: 'production_orders', key: 'production.orders', label: 'Total Production Orders', definition: 'Orders planned to start in the period (cancelled orders left out).',
    uses: ['period'], measure: COUNT, basis: 'production_dashboard.orders',
    conditions: (c) => [neq('status', 'CANCELLED'), ...between('planned_start_date', c.from, c.to)] },
  { ...PROD, source: 'production_orders', key: 'production.open', label: 'Pending Production', definition: 'Orders not completed or cancelled, with quantity still to produce.',
    measure: COUNT, basis: 'production_dashboard.open_orders', conditions: () => [notIn('status', ['COMPLETED', 'CANCELLED'])] },
  { ...PROD, source: 'production_orders', key: 'production.completed', label: 'Completed Production', definition: 'Orders completed in the period.', uses: ['period'],
    measure: COUNT, basis: 'production_dashboard.orders_completed', conditions: (c) => [eq('status', 'COMPLETED'), ...between('actual_completion_date', c.from, c.to)] },
  { ...PROD, source: 'production_outputs', key: 'production.today', label: 'Production Today', definition: 'Good quantity accepted into stock today.', uses: ['today', 'unit'],
    measure: qty('good_quantity', 'unit'), basis: 'production_dashboard.produced_today',
    conditions: (c) => [posted, eq('production_date', c.today), gt('good_quantity', 0), ...unitIs('unit')(c)] },
  { ...PROD, source: 'production_outputs', key: 'production.month', label: 'Monthly Production', definition: 'Good quantity accepted this calendar month.', uses: ['today', 'unit'],
    measure: qty('good_quantity', 'unit'), basis: 'production_dashboard.produced_month',
    conditions: (c) => [posted, ...between('production_date', monthStart(c.today), c.today), gt('good_quantity', 0), ...unitIs('unit')(c)] },
  { ...PROD, source: 'production_outputs', key: 'production.finished_goods', label: 'Finished Goods Produced', definition: 'Finished goods accepted into stock in the period.',
    uses: ['period', 'unit'], measure: qty('good_quantity', 'unit'), basis: 'production_dashboard.finished_goods',
    conditions: (c) => [posted, ...between('production_date', c.from, c.to), gt('good_quantity', 0), productIs('product_id', 'product_type', 'eq', 'FINISHED_GOOD'), ...unitIs('unit')(c)] },
  { ...PROD, source: 'production_outputs', key: 'production.rejected', label: 'Rejected Quantity', definition: 'Quantity rejected at production in the period.',
    uses: ['period', 'unit'], measure: qty('rejected_quantity', 'unit'), basis: 'production_dashboard.rejected',
    conditions: (c) => [posted, ...between('production_date', c.from, c.to), gt('rejected_quantity', 0), ...unitIs('unit')(c)] },
  { ...PROD, source: 'production_outputs', key: 'production.output', label: 'Production Output', definition: 'Production receipts posted in the chosen period.', uses: ['segmentRange', 'unit'],
    measure: qty('good_quantity', 'unit'), basis: 'management_overview.production.daily[bucket].good',
    conditions: (c) => { const r = segRange(c); return [posted, ...between('production_date', r.from, r.to), ...unitIs('unit')(c)] } },
  { ...PROD, source: 'production_consumption', key: 'production.raw_materials', label: 'Raw Materials Consumed', definition: 'Raw materials consumed by production in the period.',
    uses: ['period', 'unit'], measure: qty('actual_quantity', 'unit'), basis: 'production_dashboard.raw_materials',
    conditions: (c) => [posted, ...between('consumption_date', c.from, c.to), productIs('component_product_id', 'product_type', 'eq', 'RAW_MATERIAL'), ...unitIs('unit')(c)] },
  { ...PROD, source: 'production_consumption', key: 'production.components', label: 'Components Consumed', definition: 'Components, subassemblies, outsourced parts and packing consumed in the period.',
    uses: ['period', 'unit'], measure: qty('actual_quantity', 'unit'), basis: 'production_dashboard.components',
    conditions: (c) => [posted, ...between('consumption_date', c.from, c.to), productIs('component_product_id', 'product_type', 'neq', 'RAW_MATERIAL'), ...unitIs('unit')(c)] },
  { ...PROD, source: 'production_shortages', key: 'production.shortages', label: 'Production Shortages', definition: 'Materials short for open production orders (still to issue, minus reserved and free stock).',
    measure: COUNT, basis: 'production_dashboard.shortages', rpcArgs: (c) => ({ p_from: c.from, p_to: c.to }), conditions: () => [] },

  // --- Sales ----------------------------------------------------------------
  { ...SALES, key: 'sales.total', label: 'Total Sales Orders', definition: 'Orders dated in the period, in any status.', uses: ['period', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.total_orders', rpcArgs: salesPeriod, conditions: () => [] },
  { ...SALES, key: 'sales.today', label: 'Orders Created Today', definition: 'Orders dated today.', uses: ['today', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.created_today', rpcArgs: (c) => salesArgs(c.today, c.today)(c), conditions: () => [] },
  { ...SALES, key: 'sales.month', label: 'Orders This Month', definition: 'Orders dated this calendar month.', uses: ['today', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.this_month', rpcArgs: (c) => salesArgs(monthStart(c.today), c.today)(c), conditions: () => [] },
  { ...SALES, key: 'sales.value', label: 'Sales Order Value (Excl. GST)', definition: 'Taxable totals of orders dated in the period, cancelled orders left out.', uses: ['period', 'customer', 'status'],
    measure: money('taxable_total'), basis: 'sales_dashboard.total_value', rpcArgs: salesPeriod, conditions: () => [neq('status', 'CANCELLED')] },
  { ...SALES, key: 'sales.booked', dashboard: 'management', label: 'Sales Orders', definition: 'Orders dated in the period, cancelled orders left out (value excl. GST).', uses: ['period'],
    measure: money('taxable_total'), basis: 'sales_dashboard.total_orders − cancelled', rpcArgs: salesPeriod, conditions: () => [neq('status', 'CANCELLED')] },
  { ...SALES, key: 'sales.pending', label: 'Pending Orders', definition: 'Orders dated in the period with nothing dispatched yet.', uses: ['period', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.pending', rpcArgs: salesPeriod, conditions: () => [isIn('status', SO_PENDING)] },
  { ...SALES, key: 'sales.partial', label: 'Partially Fulfilled Orders', definition: 'Orders dated in the period, partly dispatched.', uses: ['period', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.partially_fulfilled', rpcArgs: salesPeriod, conditions: () => [eq('status', 'PARTIALLY_DISPATCHED')] },
  { ...SALES, key: 'sales.fulfilled', label: 'Fully Fulfilled Orders', definition: 'Orders dated in the period, dispatched in full.', uses: ['period', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.fully_fulfilled', rpcArgs: salesPeriod, conditions: () => [eq('status', 'FULLY_DISPATCHED')] },
  { ...SALES, key: 'sales.cancelled', label: 'Cancelled Orders', definition: 'Orders dated in the period that were cancelled.', uses: ['period', 'customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.cancelled', rpcArgs: salesPeriod, conditions: () => [eq('status', 'CANCELLED')] },
  { ...SALES, key: 'sales.awaiting', label: 'Orders Awaiting Dispatch', definition: 'Open orders (any date) with reserved goods ready to go.', uses: ['customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.awaiting_dispatch', rpcArgs: salesArgs(null, null), conditions: () => [isIn('status', SO_AWAITING), anyGt('units', 'reserved', 0)] },
  { ...SALES, key: 'sales.reserved', label: 'Finished Goods Reserved', definition: 'Open orders (any date) with finished goods reserved in the warehouse.', uses: ['customer', 'status'], measure: COUNT,
    basis: 'sales_dashboard.finished_goods_reserved (orders holding it)', rpcArgs: salesArgs(null, null), conditions: () => [notIn('status', SO_CLOSED), anyGt('units', 'reserved', 0)] },
  { ...SALES, source: 'sales_shortages', key: 'sales.shortages', label: 'Raw Material Shortages', definition: 'Materials short for open sales orders.', uses: ['period', 'customer', 'status'],
    measure: COUNT, basis: 'sales_dashboard.shortages', rpcArgs: (c) => ({ p_from: c.from, p_to: c.to, p_customer_id: c.customer ?? null, p_status: c.status ?? null }), conditions: () => [] },
  { dashboard: 'management', permissions: ['sales_orders.read'], source: 'sales_orders_view', key: 'sales.booked_period', label: 'Sales Orders Booked',
    definition: 'Orders dated in the chosen period, drafts and cancelled orders left out (value excl. GST).', uses: ['segmentRange'], measure: money('taxable_total'),
    basis: 'management_overview.sales.daily / monthly', conditions: (c) => { const r = segRange(c); return [...between('order_date', r.from, r.to), notIn('order_status', ['DRAFT', 'CANCELLED'])] } },

  // --- Invoices -------------------------------------------------------------
  { ...BILL, key: 'billing.total', label: 'Total invoices', definition: 'Invoices issued with an invoice date in the period.', uses: BILL_USES, measure: COUNT,
    basis: 'invoice_dashboard.total_invoices', conditions: (c) => [...invPeriod(c), issued] },
  { ...BILL, key: 'billing.value', label: 'Taxable Sales', definition: 'Taxable value (GST excluded) of invoices issued in the period.', uses: BILL_USES, measure: money('taxable_subtotal'),
    basis: 'invoice_dashboard.total_value', conditions: (c) => [...invPeriod(c), issued] },
  { ...BILL, key: 'billing.taxable', label: 'Taxable value', definition: 'Taxable value (before GST) of invoices issued in the period.', uses: BILL_USES, measure: money('taxable_subtotal'),
    basis: 'invoice_dashboard.taxable_value', conditions: (c) => [...invPeriod(c), issued] },
  { ...BILL, key: 'billing.gst', label: 'GST', definition: 'CGST + SGST + IGST on invoices issued in the period.', uses: BILL_USES, measure: money('cgst_total', 'sgst_total', 'igst_total'),
    basis: 'invoice_dashboard.gst_collected', conditions: (c) => [...invPeriod(c), issued] },
  { ...BILL, key: 'billing.received', label: 'Amount received (incl. GST)', definition: 'Payments allocated to invoices issued in the period (receipts are not split into taxable value and GST).', uses: BILL_USES, measure: money('paid'),
    basis: 'invoice_dashboard.amount_received', conditions: (c) => [...invPeriod(c), issued] },
  { ...BILL, key: 'billing.outstanding', label: 'Outstanding Receivables (Excl. GST)', definition: 'Invoices issued in the period with a balance still due. Part-paid invoices show no GST-exclusive balance (payments are not split) and are flagged for review.', uses: BILL_USES, measure: money('outstanding_excl_gst'),
    basis: 'invoice_dashboard.outstanding', conditions: (c) => [...invPeriod(c), issued, gt('balance_due', 0)] },
  { ...BILL, key: 'billing.overdue', label: 'Overdue (Excl. GST)', definition: 'Invoices issued in the period that are past their due date. Part-paid invoices are flagged for review.', uses: BILL_USES, measure: money('outstanding_excl_gst'),
    basis: 'invoice_dashboard.overdue_amount', conditions: (c) => [...invPeriod(c), issued, eq('display_status', 'OVERDUE')] },
  { ...BILL, key: 'billing.partially_paid', label: 'Partially paid', definition: 'Invoices issued in the period that are partly paid.', uses: BILL_USES, measure: COUNT,
    basis: 'invoice_dashboard.partially_paid', conditions: (c) => [...invPeriod(c), issued, eq('payment_status', 'PARTIALLY_PAID')] },
  { ...BILL, key: 'billing.fully_paid', label: 'Fully paid', definition: 'Invoices issued in the period that are paid in full.', uses: BILL_USES, measure: COUNT,
    basis: 'invoice_dashboard.fully_paid', conditions: (c) => [...invPeriod(c), issued, eq('payment_status', 'PAID')] },
  { ...BILL, key: 'billing.drafts', label: 'Drafts', definition: 'Draft invoices (incl. awaiting approval) dated in the period; proforma invoices are counted separately.', uses: BILL_USES, measure: COUNT,
    basis: 'invoice_dashboard.drafts', conditions: (c) => [...invPeriod(c), ...invoiceStatusIs('DRAFT')] },
  { ...BILL, key: 'billing.proforma', label: 'Proforma', definition: 'Proforma invoices dated in the period.', uses: BILL_USES, measure: COUNT,
    basis: 'invoice_dashboard.proforma', conditions: (c) => [...invPeriod(c), ...invoiceStatusIs('PROFORMA')] },
  { ...BILL, key: 'billing.cancelled', label: 'Cancelled', definition: 'Invoices dated in the period that were cancelled.', uses: BILL_USES, measure: COUNT,
    basis: 'invoice_dashboard.cancelled', conditions: (c) => [...invPeriod(c), eq('status', 'CANCELLED')] },
  { ...BILL, key: 'billing.today', label: 'Created today', definition: 'Drafts, proforma and issued invoices created today.', uses: ['today', 'customer'], measure: COUNT,
    basis: 'invoice_dashboard.created_today', conditions: (c) => [...invBase(c), dayBetween('created_at', c.today, c.today, c.tz)] },
  { ...BILL, key: 'billing.month', label: 'Issued this month', definition: 'Invoices issued with an invoice date this calendar month.', uses: ['today', 'customer'], measure: COUNT,
    basis: 'invoice_dashboard.this_month', conditions: (c) => [...invBase(c), issued, ...between('invoice_date', monthStart(c.today), c.today)] },
  { ...BILL, key: 'billing.month_invoiced', label: 'Taxable sales invoiced', definition: 'Invoices issued with an invoice date in the chosen month (taxable value, GST excluded).', uses: ['segmentRange', 'customer'], measure: money('taxable_subtotal'),
    basis: 'invoice_dashboard.monthly[month].invoiced', conditions: (c) => { const r = segRange(c); return [...invBase(c), issued, ...between('invoice_date', r.from, r.to)] } },
  { dashboard: 'billing', permissions: ['invoices.read', 'billing_reports.read', 'payments.read'], source: 'payments', key: 'billing.month_received', label: 'Received (incl. GST)',
    definition: 'Customer payments recorded with a receipt date in the chosen month (reversed payments left out). Receipts are not split into taxable value and GST.', uses: ['segmentRange', 'customer'], measure: money('amount_received'),
    basis: 'invoice_dashboard.monthly[month].received',
    conditions: (c) => { const r = segRange(c); return [eq('status', 'RECORDED'), ...between('receipt_date', r.from, r.to), ...(c.customer ? [eq('customer_id', c.customer)] : [])] } },
  { ...BILL, dashboard: 'management', key: 'billing.issued_period', label: 'Taxable Sales', definition: 'Invoices issued with an invoice date in the period (taxable value, GST excluded).', uses: ['period'],
    measure: money('taxable_subtotal'), basis: 'management_overview.kpis.sales_invoiced / invoices', conditions: (c) => [neq('status', 'DISCARDED'), issued, ...between('invoice_date', c.from, c.to)] },
  { ...BILL, dashboard: 'management', key: 'billing.outstanding_all', label: 'Outstanding Receivables (Excl. GST)', definition: 'Issued invoices with a balance still due (any date). Part-paid invoices show no GST-exclusive balance (payments are not split) and are flagged for review.', measure: money('outstanding_excl_gst'),
    basis: 'management_overview.kpis.customer_outstanding', conditions: () => [neq('status', 'DISCARDED'), issued, gt('balance_due', 0)] },

  // --- Product Master list (product_kpis) -----------------------------------------------------
  { ...PM, key: 'pm.active', label: 'Total Active Products', definition: 'Products with status Active.', basis: 'product_kpis.active',
    conditions: () => [eq('status', 'ACTIVE')] },
  { ...PM, key: 'pm.finished_goods', label: 'Finished Goods', definition: 'Active products of type Finished good.', basis: 'product_kpis.finished_goods',
    conditions: () => [eq('status', 'ACTIVE'), eq('product_type', 'FINISHED_GOOD')] },
  { ...PM, key: 'pm.raw_materials', label: 'Raw Materials', definition: 'Active products of type Raw material.', basis: 'product_kpis.raw_materials',
    conditions: () => [eq('status', 'ACTIVE'), eq('product_type', 'RAW_MATERIAL')] },
  { ...PM, key: 'pm.components', label: 'Components', definition: 'Active products of type Component.', basis: 'product_kpis.components',
    conditions: () => [eq('status', 'ACTIVE'), eq('product_type', 'COMPONENT')] },
  { ...PM, key: 'pm.without_bom', label: 'Without BOM', definition: 'Active finished goods and subassemblies with no approved BOM.', basis: 'product_kpis.without_bom',
    conditions: () => [eq('status', 'ACTIVE'), isIn('product_type', ['FINISHED_GOOD', 'SUBASSEMBLY']), isFalse('has_bom')] },
  { ...PM, key: 'pm.incomplete', label: 'Products with Missing Information',
    definition: 'Active products without an HSN code, GST rate or category, or without the selling price (finished goods) or a cost (other types).',
    basis: 'product_kpis.incomplete', conditions: () => [eq('status', 'ACTIVE'), ...MISSING_INFO] },
  { ...PM, key: 'pm.inactive', label: 'Inactive Products', definition: 'Inactive products that are not archived.', basis: 'product_kpis.inactive',
    conditions: () => [eq('status', 'INACTIVE'), isNull('archived_at')] },

  // --- Purchase Orders list (purchase_order_dashboard.by_status) --------------------------------
  { ...PO, dashboard: 'purchase_orders', key: 'purchase.status', label: 'Purchase Orders by Status', definition: 'Purchase orders in the chosen status.', uses: ['segment'],
    measure: COUNT, basis: 'purchase_order_dashboard.by_status[status]', conditions: (c) => [eq('status', c.segment ?? '')] },

  // --- Goods Received list ---------------------------------------------------------------------
  { ...GRN, dashboard: 'goods_receipts', key: 'grn.rejected_all', label: 'Rejected Quantity', definition: 'Posted goods receipts with goods rejected (all units).',
    measure: { kind: 'sum', columns: ['total_rejected'], format: 'quantity' }, basis: 'goods_receipt_lines.rejected_quantity of posted receipts',
    conditions: () => [posted, gt('total_rejected', 0)] },
  { ...GRN, dashboard: 'goods_receipts', key: 'grn.reversed', label: 'Reversed GRNs', definition: 'Goods receipts that were reversed (kept in the history).',
    basis: 'module_dashboard(GRN).reversed', conditions: () => [eq('status', 'REVERSED')] },

  // --- Per-product stock card (segment = product id) -------------------------------------------
  { ...LOTS, key: 'stock.product_on_hand', label: 'Stock on Hand', definition: 'Stock lots of this product with quantity on hand.', measure: qty('on_hand', 'base_unit'),
    basis: 'inventory_product_stock.on_hand', conditions: (c) => [eq('product_id', c.segment ?? ''), neq('on_hand', 0)] },
  { ...LOTS, key: 'stock.product_reserved', label: 'Reserved Stock', definition: 'Stock lots of this product with quantity reserved.', measure: qty('reserved', 'base_unit'),
    basis: 'inventory_product_stock.reserved', conditions: (c) => [eq('product_id', c.segment ?? ''), neq('reserved', 0)] },
  { ...LOTS, key: 'stock.product_available', label: 'Available Stock', definition: 'Stock lots of this product available in storage locations (on hand minus reserved).',
    measure: qty('available', 'base_unit'), basis: 'inventory_product_stock.available', conditions: (c) => [eq('product_id', c.segment ?? ''), neq('available', 0)] },
  ...(['IN_HOUSE', 'OUTSOURCED', 'UNKNOWN'] as const).map((src): DrillMetric => ({ ...LOTS, key: `stock.product_${src.toLowerCase()}`,
    label: src === 'IN_HOUSE' ? 'In-house Stock' : src === 'OUTSOURCED' ? 'Outsourced Stock' : 'Stock with Unverified Source',
    definition: `Stock lots of this product with source ${src === 'UNKNOWN' ? 'not recorded' : src === 'IN_HOUSE' ? 'in-house' : 'outsourced'}.`, measure: qty('on_hand', 'base_unit'),
    basis: `inventory_product_stock.${src === 'IN_HOUSE' ? 'in_house_on_hand' : src === 'OUTSOURCED' ? 'outsourced_on_hand' : 'unknown_source_on_hand'}`,
    conditions: (c) => [eq('product_id', c.segment ?? ''), eq('source_type', src), neq('on_hand', 0)] })),

  // --- Ledger list (ledgerSummary of ledger_parties rows; segment = CUSTOMER / SUPPLIER scope) ----
  ...(['CUSTOMER', 'SUPPLIER', 'BOTH'] as const).map((type): DrillMetric => ({ ...LEDGER, dashboard: 'ledger_list', key: `ledger.page_${type.toLowerCase()}`,
    label: type === 'CUSTOMER' ? 'Customers' : type === 'SUPPLIER' ? 'Suppliers' : 'Customer & Supplier', measure: COUNT,
    definition: `Active parties that are ${type === 'BOTH' ? 'both a customer and a supplier' : `${type.toLowerCase()}s only`}.`, basis: 'ledgerSummary(ledger_parties)',
    conditions: () => [eq('status', 'ACTIVE'), eq('party_type', type)] })),
  { ...LEDGER, dashboard: 'ledger_list', key: 'ledger.page_with_balance', label: 'Parties with a Balance', uses: ['segment'], measure: COUNT,
    definition: 'Parties with a receivable or payable balance (active and inactive).', basis: 'ledgerSummary(ledger_parties).withBalance',
    conditions: (c) => [or(neq('receivable', 0), neq('payable', 0)), ...ledgerScope(c)] },

  // --- Ledger ---------------------------------------------------------------
  { ...LEDGER, key: 'ledger.customers', label: 'Total Customers', definition: 'Parties that are customers (incl. those that are also suppliers).', measure: COUNT,
    basis: 'module_dashboard(LEDGER).customers', conditions: () => [isIn('party_type', ['CUSTOMER', 'BOTH'])] },
  { ...LEDGER, key: 'ledger.suppliers', label: 'Total Suppliers', definition: 'Parties that are suppliers (incl. those that are also customers).', measure: COUNT,
    basis: 'module_dashboard(LEDGER).suppliers', conditions: () => [isIn('party_type', ['SUPPLIER', 'BOTH'])] },
  { ...LEDGER, key: 'ledger.both', label: 'Customer and Supplier', definition: 'Parties that are both a customer and a supplier.', measure: COUNT,
    basis: 'module_dashboard(LEDGER).both', conditions: () => [eq('party_type', 'BOTH')] },
  { ...LEDGER, key: 'ledger.with_balance', label: 'Outstanding Balances', definition: 'Parties with a receivable or payable balance.', measure: COUNT,
    basis: 'module_dashboard(LEDGER).with_balance', conditions: () => [or(neq('receivable', 0), neq('payable', 0))] },
  { ...LEDGER, key: 'ledger.receivables', label: 'Outstanding Receivables (Excl. GST)', definition: 'Customers who owe money; advances are not netted. Balances with payments or opening balances cannot be split into taxable value and GST and are flagged for review.', measure: money('receivable_excl_gst'),
    basis: 'module_dashboard(LEDGER).receivables', conditions: () => [gt('receivable', 0)] },
  { ...LEDGER, key: 'ledger.payables', label: 'Outstanding Payables (Excl. GST)', definition: 'Suppliers the company owes (goods received − payments). Balances with payments or opening balances cannot be split into taxable value and GST and are flagged for review.', measure: money('payable_excl_gst'),
    basis: 'module_dashboard(LEDGER).payables', conditions: () => [gt('payable', 0)] },
]

export const METRICS: Record<string, DrillMetric> = Object.fromEntries(list.map((m) => [m.key, m]))
export const METRIC_LIST = list

export const isMetricKey = (key: string | null | undefined): key is string => Boolean(key && key in METRICS)
