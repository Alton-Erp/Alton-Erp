import { requireSupabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import type { AdjustmentFilters } from '@/features/inventory/adjustments-model'
import type { ExistingOpening } from '@/features/inventory/opening-import'
import { isMissingFunction } from '@/services/purchase-costs'
import type {
  AdjustmentRow,
  AlertRow,
  ApprovalStatus,
  CountLineRow,
  CountRow,
  LocationRow,
  OpeningBatchRow,
  OpeningLineRow,
  ProductStockRow,
  ReservationRow,
  ReservationStatus,
  StockDetailRow,
  StockSource,
  StockStatus,
  TransactionListRow,
  TransactionType,
  WarehouseRow,
} from '@/types/database-inventory'

/**
 * Inventory data access. Reads go through RLS-protected tables/views; every
 * stock change goes through a SECURITY DEFINER RPC that checks permissions,
 * locks rows and uses an idempotency key (one key per user action, reused on
 * retry so a double click or network retry cannot post twice).
 */

const db = () => requireSupabase()

async function rpc<T = Json>(fn: string, args: Record<string, unknown>): Promise<T> {
  // The generated function types are strict per function; this helper keeps
  // call sites concise while results are typed by the caller.
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Policy, overview, lookups
// ---------------------------------------------------------------------------
export interface InventoryPolicy {
  segregation_of_duties: boolean
  expiry_warning_days: number
  timezone: string
  today: string
  negative_stock_allowed: boolean
}

export const fetchInventoryPolicy = () => rpc<InventoryPolicy>('inventory_policy_info', {})

export interface UnitTotals {
  unit: string
  on_hand: number
  reserved: number
  available: number
  in_house: number
  outsourced: number
  unknown: number
}

export interface InventoryOverview {
  active_products: number
  products_with_stock: number
  never_stocked: number
  out_of_stock: number
  fully_reserved: number
  low_stock: number
  healthy: number
  no_threshold: number
  units: UnitTotals[]
  by_category: { category: string; unit: string; on_hand: number }[]
  by_warehouse: { warehouse_code: string; warehouse_name: string; unit: string; on_hand: number }[]
  first_transaction_at: string | null
  last_transaction_at: string | null
  warehouses: number
  pending_opening: number
  pending_adjustments: number
  pending_counts: number
  timezone: string
  as_of: string
}

export const fetchInventoryOverview = () => rpc<InventoryOverview>('inventory_overview', {})

export interface TrendPoint {
  bucket: string
  unit: string
  quantity_in: number
  quantity_out: number
  transactions: number
}

export const fetchMovementTrend = (from: string, to: string, bucket: 'day' | 'week' | 'month' | 'year') =>
  rpc<TrendPoint[]>('inventory_movement_trend', { p_from: from, p_to: to, p_bucket: bucket })

export interface ProductOption {
  product_id: string
  sku: string
  product_name: string
  base_unit: string
  track_batches: boolean
  track_expiry: boolean
  product_status?: string
}

/** Exact barcode or SKU match (keyboard-wedge scanners send the code + Enter). */
export const findProductByCode = (code: string) => rpc<(ProductOption & { matched_on: 'BARCODE' | 'SKU' })[]>('inventory_find_product_by_code', { p_code: code })

/** Type-ahead product search (SKU, name, barcode). */
export async function searchProducts(term: string, includeInactive = false): Promise<ProductOption[]> {
  const clean = term.replace(/[^\p{L}\p{N} ._/-]/gu, ' ').trim().slice(0, 60)
  let query = db()
    .from('products')
    .select('id, sku, product_name, base_unit, track_batches, track_expiry, status')
    .is('archived_at', null)
    .order('sku')
    .limit(15)
  if (!includeInactive) query = query.eq('status', 'ACTIVE')
  if (clean) query = query.or(`sku.ilike.%${clean}%,product_name.ilike.%${clean}%,barcode.ilike.%${clean}%`)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map((p) => ({
    product_id: p.id,
    sku: p.sku,
    product_name: p.product_name,
    base_unit: p.base_unit,
    track_batches: p.track_batches,
    track_expiry: p.track_expiry,
    product_status: p.status,
  }))
}

// ---------------------------------------------------------------------------
// Warehouses & locations
// ---------------------------------------------------------------------------
export interface StorageData {
  warehouses: WarehouseRow[]
  locations: LocationRow[]
}

export async function fetchStorage(): Promise<StorageData> {
  const [w, l] = await Promise.all([
    db().from('warehouses').select('*').order('warehouse_code'),
    db().from('inventory_locations').select('*').order('location_code'),
  ])
  if (w.error) throw w.error
  if (l.error) throw l.error
  return { warehouses: w.data ?? [], locations: l.data ?? [] }
}

export async function createWarehouse(companyId: string, input: { code: string; name: string; address: string | null; isDefault: boolean }) {
  const { error } = await db()
    .from('warehouses')
    .insert({ company_id: companyId, warehouse_code: input.code, warehouse_name: input.name, address: input.address, is_default: input.isDefault })
  if (error) throw error
}

export async function updateWarehouse(id: string, changes: { warehouse_name?: string; address?: string | null; status?: 'ACTIVE' | 'INACTIVE'; is_default?: boolean }) {
  const { error, count } = await db().from('warehouses').update(changes, { count: 'exact' }).eq('id', id)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

export async function createLocation(
  companyId: string,
  input: {
    warehouseId: string
    parentId: string | null
    code: string
    name: string
    type: LocationRow['location_type']
    usage: LocationRow['stock_usage']
    externalHolder: string | null
  },
) {
  const { error } = await db().from('inventory_locations').insert({
    company_id: companyId,
    warehouse_id: input.warehouseId,
    parent_location_id: input.parentId,
    location_code: input.code,
    location_name: input.name,
    location_type: input.type,
    stock_usage: input.usage,
    external_holder: input.usage === 'EXTERNAL_PROCESSING' ? input.externalHolder : null,
  })
  if (error) throw error
}

export async function updateLocation(
  id: string,
  changes: {
    location_name?: string
    location_type?: LocationRow['location_type']
    parent_location_id?: string | null
    status?: 'ACTIVE' | 'INACTIVE'
    stock_usage?: LocationRow['stock_usage']
    external_holder?: string | null
  },
) {
  const { error, count } = await db().from('inventory_locations').update(changes, { count: 'exact' }).eq('id', id)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

/** Location stock totals (for showing which locations hold stock). */
export async function fetchLocationStockTotals(): Promise<Map<string, number>> {
  const { data, error } = await db().from('inventory_balances').select('location_id, on_hand, reserved')
  if (error) throw error
  const totals = new Map<string, number>()
  for (const r of data ?? []) totals.set(r.location_id, (totals.get(r.location_id) ?? 0) + Number(r.on_hand) + Number(r.reserved))
  return totals
}

// ---------------------------------------------------------------------------
// Stock register (server-side filtering / sorting / paging)
// ---------------------------------------------------------------------------
export interface RegisterFilters {
  search: string
  categoryId: string | null
  productType: string | null
  stockStatus: string | null
  includeInactive: boolean
}

export const sanitizeTerm = (v: string) => v.replace(/[^\p{L}\p{N} ._/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

export async function fetchProductStock(
  filters: RegisterFilters,
  sort: { column: string; ascending: boolean },
  page: number,
  pageSize: number,
): Promise<{ rows: ProductStockRow[]; total: number }> {
  let query = db().from('inventory_product_stock').select('*', { count: 'exact' }).is('archived_at', null)
  const term = sanitizeTerm(filters.search)
  if (term) query = query.or(`sku.ilike.%${term}%,product_name.ilike.%${term}%,barcode.ilike.%${term}%`)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.productType) query = query.eq('product_type', filters.productType)
  if (filters.stockStatus) query = query.eq('stock_status', filters.stockStatus as StockStatus)
  if (!filters.includeInactive) query = query.eq('product_status', 'ACTIVE')
  const from = page * pageSize
  const { data, error, count } = await query
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    .order('product_id')
    .range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: data ?? [], total: count ?? 0 }
}

export interface DetailFilters {
  search: string
  productId: string | null
  categoryId: string | null
  productType: string | null
  source: string | null
  warehouseId: string | null
  locationId: string | null
  batchId?: string | null
  expiringBefore?: string | null
}

function detailQuery(filters: DetailFilters, count: boolean) {
  let query = db().from('inventory_stock_detail').select('*', count ? { count: 'exact' } : undefined)
  const term = sanitizeTerm(filters.search)
  if (term) query = query.or(`sku.ilike.%${term}%,product_name.ilike.%${term}%,barcode.ilike.%${term}%,batch_number.ilike.%${term}%`)
  if (filters.productId) query = query.eq('product_id', filters.productId)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.productType) query = query.eq('product_type', filters.productType)
  if (filters.source) query = query.eq('source_type', filters.source as StockSource)
  if (filters.warehouseId) query = query.eq('warehouse_id', filters.warehouseId)
  if (filters.locationId) query = query.eq('location_id', filters.locationId)
  if (filters.batchId) query = query.eq('batch_id', filters.batchId)
  if (filters.expiringBefore) query = query.lte('expiry_date', filters.expiringBefore)
  return query
}

export async function fetchStockDetail(
  filters: DetailFilters,
  sort: { column: string; ascending: boolean },
  page: number,
  pageSize: number,
): Promise<{ rows: StockDetailRow[]; total: number }> {
  const from = page * pageSize
  const { data, error, count } = await detailQuery(filters, true)
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    .order('balance_id')
    .range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: (data ?? []) as StockDetailRow[], total: count ?? 0 }
}

/** All rows for export (pages of 1000, capped). */
export async function fetchAllStockDetail(filters: DetailFilters, limit = 20000): Promise<StockDetailRow[]> {
  const rows: StockDetailRow[] = []
  for (let from = 0; from < limit; from += 1000) {
    const { data, error } = await detailQuery(filters, false).order('sku').order('balance_id').range(from, from + 999)
    if (error) throw error
    rows.push(...((data ?? []) as StockDetailRow[]))
    if ((data ?? []).length < 1000) break
  }
  return rows
}

export async function fetchAllProductStock(filters: RegisterFilters, limit = 20000): Promise<ProductStockRow[]> {
  const rows: ProductStockRow[] = []
  for (let from = 0; from < limit; from += 1000) {
    const page = await fetchProductStock(filters, { column: 'sku', ascending: true }, from / 1000, 1000)
    rows.push(...page.rows)
    if (page.rows.length < 1000) break
  }
  return rows
}

/** Lots of a product at a location with stock (for issue / transfer / reserve). */
export async function fetchLotsAt(productId: string, locationId: string): Promise<StockDetailRow[]> {
  const { data, error } = await db()
    .from('inventory_stock_detail')
    .select('*')
    .eq('product_id', productId)
    .eq('location_id', locationId)
    .gt('on_hand', 0)
    .order('expiry_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as StockDetailRow[]
}

export async function fetchProductStockRow(productId: string): Promise<ProductStockRow> {
  const { data, error } = await db().from('inventory_product_stock').select('*').eq('product_id', productId).single()
  if (error) throw error
  return data as ProductStockRow
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------
export interface MovementFilters {
  from: Date
  to: Date
  search: string
  productId: string | null
  transactionType: string | null
  source: string | null
  warehouseId: string | null
  locationId: string | null
  batchId: string | null
  userId: string | null
  reference: string
}

function movementQuery(filters: MovementFilters, count: boolean) {
  let query = db()
    .from('inventory_transaction_list')
    .select('*', count ? { count: 'exact' } : undefined)
    .gte('transaction_date', filters.from.toISOString())
    .lte('transaction_date', filters.to.toISOString())
  const term = sanitizeTerm(filters.search)
  if (term) query = query.or(`sku.ilike.%${term}%,product_name.ilike.%${term}%,transaction_number.ilike.%${term}%,batch_number.ilike.%${term}%`)
  const ref = sanitizeTerm(filters.reference)
  if (ref) query = query.ilike('reference_number', `%${ref}%`)
  if (filters.productId) query = query.eq('product_id', filters.productId)
  if (filters.transactionType) query = query.eq('transaction_type', filters.transactionType as TransactionType)
  if (filters.source) query = query.eq('source_type', filters.source as StockSource)
  if (filters.warehouseId) query = query.eq('warehouse_id', filters.warehouseId)
  if (filters.locationId) query = query.eq('location_id', filters.locationId)
  if (filters.batchId) query = query.eq('batch_id', filters.batchId)
  if (filters.userId) query = query.eq('created_by', filters.userId)
  return query
}

export async function fetchMovements(filters: MovementFilters, page: number, pageSize: number, ascending = false) {
  const from = page * pageSize
  const { data, error, count } = await movementQuery(filters, true)
    .order('transaction_date', { ascending })
    .order('transaction_number', { ascending })
    .range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: (data ?? []) as TransactionListRow[], total: count ?? 0 }
}

export async function fetchAllMovements(filters: MovementFilters, limit = 20000): Promise<TransactionListRow[]> {
  const rows: TransactionListRow[] = []
  for (let from = 0; from < limit; from += 1000) {
    const { data, error } = await movementQuery(filters, false).order('transaction_date').order('transaction_number').range(from, from + 999)
    if (error) throw error
    rows.push(...((data ?? []) as TransactionListRow[]))
    if ((data ?? []).length < 1000) break
  }
  return rows
}

export async function fetchTransaction(id: string): Promise<TransactionListRow> {
  const { data, error } = await db().from('inventory_transaction_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as TransactionListRow
}

export async function fetchRelatedTransactions(tx: TransactionListRow): Promise<TransactionListRow[]> {
  const filters = [`id.eq.${tx.id}`, `reversal_of_transaction_id.eq.${tx.id}`]
  if (tx.transfer_group_id) filters.push(`transfer_group_id.eq.${tx.transfer_group_id}`)
  if (tx.reversal_of_transaction_id) filters.push(`id.eq.${tx.reversal_of_transaction_id}`)
  const { data, error } = await db().from('inventory_transaction_list').select('*').or(filters.join(',')).order('created_at')
  if (error) throw error
  return (data ?? []) as TransactionListRow[]
}

/** Users who have posted movements (for the "performed by" filter). */
export async function fetchMovementUsers(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await db().from('inventory_transactions').select('created_by').not('created_by', 'is', null).limit(1000)
  if (error) throw error
  const ids = [...new Set((data ?? []).map((r) => r.created_by as string))]
  if (ids.length === 0) return []
  const names = await rpc<{ user_id: string; display_name: string }[]>('user_display_names', { p_user_ids: ids })
  return names.map((n) => ({ id: n.user_id, name: n.display_name })).sort((a, b) => a.name.localeCompare(b.name))
}

export interface ReceiptInput {
  productId: string
  locationId: string
  quantity: number
  sourceType: 'IN_HOUSE' | 'OUTSOURCED'
  batchNumber: string | null
  manufacturingDate: string | null
  expiryDate: string | null
  unitCost: number | null
  transactionType: 'RECEIPT' | 'CUSTOMER_RETURN'
  referenceType: string | null
  referenceNumber: string | null
  reason: string | null
  notes: string | null
}

export const postReceipt = (input: ReceiptInput, key: string) =>
  rpc<{ transaction_number: string; duplicate?: boolean }>('inventory_post_receipt', {
    p_product_id: input.productId,
    p_location_id: input.locationId,
    p_quantity: input.quantity,
    p_source_type: input.sourceType,
    p_batch_number: input.batchNumber,
    p_manufacturing_date: input.manufacturingDate,
    p_expiry_date: input.expiryDate,
    p_unit_cost: input.unitCost,
    p_transaction_type: input.transactionType,
    p_reference_type: input.referenceType,
    p_reference_number: input.referenceNumber,
    p_reason: input.reason,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export interface IssueInput {
  productId: string
  locationId: string
  quantity: number
  batchId: string | null
  sourceType: string | null
  transactionType: 'ISSUE' | 'SUPPLIER_RETURN'
  referenceType: string | null
  referenceNumber: string | null
  reason: string
  notes: string | null
}

export const postIssue = (input: IssueInput, key: string) =>
  rpc<{ transaction_number: string }>('inventory_post_issue', {
    p_product_id: input.productId,
    p_location_id: input.locationId,
    p_quantity: input.quantity,
    p_batch_id: input.batchId,
    p_source_type: input.sourceType,
    p_transaction_type: input.transactionType,
    p_reference_type: input.referenceType,
    p_reference_number: input.referenceNumber,
    p_reason: input.reason,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export const postTransfer = (
  input: { productId: string; fromLocationId: string; toLocationId: string; quantity: number; batchId: string | null; referenceNumber: string | null; reason: string | null; notes: string | null },
  key: string,
) =>
  rpc<{ out_transaction_number: string; in_transaction_number: string }>('inventory_transfer_stock', {
    p_product_id: input.productId,
    p_from_location_id: input.fromLocationId,
    p_to_location_id: input.toLocationId,
    p_quantity: input.quantity,
    p_batch_id: input.batchId,
    p_reference_number: input.referenceNumber,
    p_reason: input.reason,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export const reverseTransaction = (transactionId: string, reason: string, key: string) =>
  rpc<{ reversal_numbers: string[] }>('inventory_reverse_transaction', { p_transaction_id: transactionId, p_reason: reason, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------
export type ReservationListRow = ReservationRow & { sku: string; product_name: string; base_unit: string; location_code: string; warehouse_code: string; batch_number: string | null; source_type: string }

export async function fetchReservations(status: string | null): Promise<ReservationListRow[]> {
  let query = db().from('stock_reservations').select('*').order('reserved_at', { ascending: false }).limit(1000)
  if (status === 'OPEN') query = query.in('reservation_status', ['ACTIVE', 'PARTIALLY_FULFILLED'])
  else if (status) query = query.eq('reservation_status', status as ReservationStatus)
  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []
  return enrichWithStock(rows)
}

async function enrichWithStock<T extends { product_id: string; location_id: string; batch_id: string | null; warehouse_id: string }>(
  rows: T[],
): Promise<(T & { sku: string; product_name: string; base_unit: string; location_code: string; warehouse_code: string; batch_number: string | null; source_type: string })[]> {
  if (rows.length === 0) return []
  const productIds = [...new Set(rows.map((r) => r.product_id))]
  const batchIds = [...new Set(rows.map((r) => r.batch_id).filter((b): b is string => Boolean(b)))]
  const [products, batches, storage] = await Promise.all([
    db().from('products').select('id, sku, product_name, base_unit').in('id', productIds),
    batchIds.length ? db().from('inventory_batches').select('id, batch_number, source_type').in('id', batchIds) : Promise.resolve({ data: [], error: null }),
    fetchStorage(),
  ])
  if (products.error) throw products.error
  if (batches.error) throw batches.error
  const p = new Map((products.data ?? []).map((x) => [x.id, x]))
  const b = new Map((batches.data ?? []).map((x) => [x.id, x]))
  const l = new Map(storage.locations.map((x) => [x.id, x]))
  const w = new Map(storage.warehouses.map((x) => [x.id, x]))
  return rows.map((r) => ({
    ...r,
    sku: p.get(r.product_id)?.sku ?? '?',
    product_name: p.get(r.product_id)?.product_name ?? '',
    base_unit: p.get(r.product_id)?.base_unit ?? '',
    location_code: l.get(r.location_id)?.location_code ?? '?',
    warehouse_code: w.get(r.warehouse_id)?.warehouse_code ?? '?',
    batch_number: r.batch_id ? (b.get(r.batch_id)?.batch_number ?? null) : null,
    source_type: (r as { source_type?: string }).source_type ?? (r.batch_id ? (b.get(r.batch_id)?.source_type ?? '') : ''),
  }))
}

export const expireReservations = () => rpc<number>('inventory_expire_reservations', {})

export const createReservation = (
  input: { productId: string; locationId: string; batchId: string | null; quantity: number; referenceType: string; referenceNumber: string; notes: string | null; expiresAt: string | null },
  key: string,
) =>
  rpc<{ reservation_number: string }>('inventory_create_reservation', {
    p_product_id: input.productId,
    p_location_id: input.locationId,
    p_quantity: input.quantity,
    p_reference_type: input.referenceType,
    p_reference_number: input.referenceNumber,
    p_batch_id: input.batchId,
    p_notes: input.notes,
    p_expires_at: input.expiresAt,
    p_idempotency_key: key,
  })

export const releaseReservation = (id: string, action: 'RELEASE' | 'CANCEL', note: string | null) =>
  rpc('inventory_release_reservation', { p_reservation_id: id, p_action: action, p_note: note })

export const fulfilReservation = (id: string, quantity: number, referenceNumber: string | null, notes: string | null, key: string) =>
  rpc<{ transaction_number: string; reservation_status: string }>('inventory_fulfil_reservation', {
    p_reservation_id: id,
    p_quantity: quantity,
    p_reference_number: referenceNumber,
    p_notes: notes,
    p_idempotency_key: key,
  })

// ---------------------------------------------------------------------------
// Opening stock
// ---------------------------------------------------------------------------
export interface OpeningLinePayload {
  line_no: number
  product_id: string
  location_id: string
  source_type: string
  quantity: number
  unit?: string | null
  batch_number?: string | null
  manufacturing_date?: string | null
  expiry_date?: string | null
  /**
   * Ignored by the *_at_cost functions: the server sets the Product Master Cost. Read only together with
   * cost_override = true, which the server accepts only when the override is enabled for the user.
   */
  unit_cost?: number | null
  cost_override?: boolean
  effective_date: string
  reference?: string | null
  notes?: string | null
}

/** Product Master Cost of a product for opening stock (public.opening_stock_product_costs, migration 20261129090000). */
export interface OpeningProductCost {
  product_id: string
  sku: string
  product_name: string
  /** Product Master Cost (product_master_list.master_cost); null = missing. */
  cost: number | null
  source: 'BOM' | 'GRN' | 'MANUAL' | 'PURCHASE' | 'STANDARD' | null
  /** False when the cost is missing or zero: the line cannot be posted. */
  valid: boolean
}

/** Product Master Costs for opening stock, fetched from the database, and whether this user may override them. */
export async function fetchOpeningCosts(productIds: string[]): Promise<{ overrideAllowed: boolean; costs: Map<string, OpeningProductCost> }> {
  const costs = new Map<string, OpeningProductCost>()
  let overrideAllowed = false
  const unique = [...new Set(productIds)]
  for (let i = 0; i < unique.length || i === 0; i += 5000) {
    const r = await rpc<{ override_allowed: boolean; costs: OpeningProductCost[] }>('opening_stock_product_costs', { p_product_ids: unique.slice(i, i + 5000) })
    overrideAllowed = r.override_allowed
    for (const c of r.costs) costs.set(c.product_id, { ...c, cost: c.cost === null ? null : Number(c.cost) })
    if (unique.length === 0) break
  }
  return { overrideAllowed, costs }
}

/**
 * Opening stock at the Product Master Cost: the server prices every line again at submission and calls the
 * existing submit / post functions (migration 20261129090000). Costs sent by the screen are ignored.
 */
export const postOpeningStockAtCost = (lines: OpeningLinePayload[], source: 'MANUAL' | 'IMPORT', fileName: string | null, notes: string | null, key: string) =>
  rpc<OpeningSubmitResult & { status?: string }>('inventory_post_opening_stock_at_cost', {
    p_lines: lines as unknown as Json, p_source: source, p_file_name: fileName, p_notes: notes, p_idempotency_key: key,
  })
export const submitOpeningStockAtCost = (lines: OpeningLinePayload[], source: 'MANUAL' | 'IMPORT', fileName: string | null, notes: string | null, key: string) =>
  rpc<OpeningSubmitResult>('inventory_submit_opening_stock_at_cost', {
    p_lines: lines as unknown as Json, p_source: source, p_file_name: fileName, p_notes: notes, p_idempotency_key: key,
  })

export type OpeningSubmitResult =
  | { ok: true; opening_batch_id: string; document_number: string; line_count: number; duplicate?: boolean }
  | { ok: false; errors: { line_no: number; message: string }[]; valid_lines: number }

/** An opening stock record the import can match (public.opening_stock_import_matches, migration 20261206090000). */
export interface OpeningImportMatch {
  opening_line_id: string
  document_number: string
  status: 'PENDING_APPROVAL' | 'POSTED'
  product_id: string
  location_id: string
  batch_number: string | null
  source_type: string
  /** Quantity of the opening record itself (never changed). */
  quantity: number
  /** Quantity added to it by earlier imports (separate ledger entries). */
  added_quantity: number
  unit_cost: number | null
  lot_id: string | null
  /** Current cost of the stock lot (null = not valued). */
  lot_cost: number | null
  on_hand: number
}

/**
 * Opening stock records of these products, for matching import rows. null when the database does not have the
 * additive import yet (migration 20261206090000 not applied): the import then keeps rejecting existing records.
 */
export async function fetchOpeningImportMatches(productIds: string[]): Promise<OpeningImportMatch[] | null> {
  const unique = [...new Set(productIds)]
  const out: OpeningImportMatch[] = []
  for (let i = 0; i < unique.length; i += 5000) {
    const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: OpeningImportMatch[] | null; error: { code?: string; message?: string } | null }>)(
      'opening_stock_import_matches', { p_product_ids: unique.slice(i, i + 5000) })
    if (error) {
      if (['PGRST202', '42883'].includes(error.code ?? '') || /opening_stock_import_matches/.test(error.message ?? '')) return null
      throw error
    }
    for (const m of data ?? []) {
      out.push({ ...m, quantity: Number(m.quantity), added_quantity: Number(m.added_quantity), on_hand: Number(m.on_hand),
        unit_cost: m.unit_cost === null ? null : Number(m.unit_cost), lot_cost: m.lot_cost === null ? null : Number(m.lot_cost) })
    }
  }
  return out
}

/** What the import changes on matched (existing) opening stock records. Quantity is always added, never replaced. */
export interface OpeningImportFields {
  quantity: boolean
  unit_cost: boolean
  remarks: boolean
}

export interface OpeningImportAddition {
  line_no: number
  document_number: string
  opening_line_id: string
  previous_quantity: number
  added_quantity: number
  new_quantity: number
  unit_cost: number | null
  cost_source: 'EXISTING_LOT_COST' | 'EXCEL_OVERRIDE' | 'PENDING'
  transaction_number: string
}

export type OpeningImportResult =
  | { ok: true; new_lines: number; opening_batch_id?: string; document_number?: string; line_count?: number; status?: string; additions: OpeningImportAddition[];
      kept: { line_no: number; document_number: string }[]; duplicate?: boolean }
  | { ok: false; errors: { line_no: number; message: string }[]; new_lines: number; added_lines: number }

/**
 * The Excel import (migration 20261206090000), one transaction: new records through the existing opening stock
 * functions, matched records get the imported quantity added as a separate ledger entry. Nothing is posted when
 * any row fails; a retry with the same key returns the first result.
 */
export const importOpeningStock = (lines: OpeningLinePayload[], fields: OpeningImportFields, post: boolean, fileName: string | null, key: string) =>
  rpc<OpeningImportResult>('inventory_import_opening_stock', {
    p_lines: lines as unknown as Json, p_fields: fields as unknown as Json, p_post: post, p_file_name: fileName, p_notes: null, p_idempotency_key: key,
  })

// Opening stock is submitted only through submitOpeningStockAtCost / postOpeningStockAtCost: the older functions accept
// any unit cost and are not callable by users (migration 20261130090000).

export const reviewOpeningStock = (id: string, decision: 'APPROVE' | 'REJECT', note: string | null, key: string) =>
  rpc<{ status: string; lines_posted: number }>('inventory_review_opening_stock', { p_opening_batch_id: id, p_decision: decision, p_note: note, p_idempotency_key: key })

export const cancelOpeningStock = (id: string) => rpc('inventory_cancel_opening_stock', { p_opening_batch_id: id })

export interface OpeningProductMeta {
  id: string
  sku: string
  status: string
  default_source_type: string | null
  product_type: string | null
}

/**
 * What opening stock entry needs to know about the chosen products, read-only:
 * their sourcing defaults (the stored source is derived from them) and any
 * opening balances already pending or posted for them, with the document number.
 */
export async function fetchOpeningContext(productIds: string[]): Promise<{ products: Map<string, OpeningProductMeta>; existing: ExistingOpening[] }> {
  const ids = [...new Set(productIds)]
  const products = new Map<string, OpeningProductMeta>()
  const existing: ExistingOpening[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const [p, l] = await Promise.all([
      db().from('products').select('id, sku, status, default_source_type, product_type').in('id', chunk),
      db().from('inventory_opening_lines').select('product_id, location_id, batch_number, opening_batch_id').in('product_id', chunk).in('status', ['PENDING_APPROVAL', 'POSTED']).limit(5000),
    ])
    if (p.error) throw p.error
    if (l.error) throw l.error
    for (const row of p.data ?? []) products.set(row.id, row as OpeningProductMeta)
    const batchIds = [...new Set((l.data ?? []).map((r) => r.opening_batch_id))]
    const numbers = new Map<string, string>()
    if (batchIds.length) {
      const b = await db().from('inventory_opening_batches').select('id, document_number').in('id', batchIds)
      if (b.error) throw b.error
      for (const row of b.data ?? []) numbers.set(row.id, row.document_number)
    }
    for (const r of l.data ?? []) existing.push({ product_id: r.product_id, location_id: r.location_id, batch_number: r.batch_number, document_number: numbers.get(r.opening_batch_id) ?? null })
  }
  return { products, existing }
}

export async function fetchOpeningBatches(): Promise<OpeningBatchRow[]> {
  const { data, error } = await db().from('inventory_opening_batches').select('*').order('requested_at', { ascending: false }).limit(500)
  if (error) throw error
  return data ?? []
}

export async function fetchOpeningLines(batchId: string | null) {
  let query = db().from('inventory_opening_lines').select('*').order('line_no').limit(5000)
  if (batchId) query = query.eq('opening_batch_id', batchId)
  const { data, error } = await query
  if (error) throw error
  return enrichWithStock((data ?? []) as (OpeningLineRow & { batch_id: null })[])
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------
/** Stock adjustments, newest first; filtered on the server (status, requested date range, product, warehouse, reason, type). */
export async function fetchAdjustments(filter: string | null | Partial<AdjustmentFilters>) {
  const f: Partial<AdjustmentFilters> = typeof filter === 'string' || filter === null ? { status: (filter ?? null) as AdjustmentFilters['status'] } : filter
  let query = db().from('inventory_adjustments').select('*').order('requested_at', { ascending: false }).limit(2000)
  if (f.status) query = query.eq('status', f.status as ApprovalStatus)
  if (f.from) query = query.gte('requested_at', f.from)
  if (f.to) query = query.lt('requested_at', `${f.to}T23:59:59.999`)
  if (f.productId) query = query.eq('product_id', f.productId)
  if (f.warehouseId) query = query.eq('warehouse_id', f.warehouseId)
  if (f.type) query = query.eq('adjustment_type', f.type)
  // A configured reason, or a fixed category code (upper-case).
  if (f.reason) query = /^[A-Z_]+$/.test(f.reason) ? query.eq('reason_code', f.reason) : (query as unknown as { eq: (c: string, v: string) => typeof query }).eq('reason_label', f.reason)
  const { data, error } = await query
  if (error) throw error
  return enrichWithStock((data ?? []) as AdjustmentRow[])
}

export interface AdjustmentInput {
  type: 'QUANTITY' | 'SOURCE_CORRECTION'
  productId: string
  locationId: string
  batchId: string | null
  batchNumber: string | null
  sourceType: string | null
  countedQuantity: number | null
  correctionQuantity: number | null
  targetSourceType: string | null
  unitCost: number | null
  reasonCode: string
  /** Reason chosen from ERP Settings → Inventory → Stock adjustment reasons (migration 20261201090000). */
  reasonLabel?: string | null
  notes: string | null
  reference: string | null
  effectiveDate: string | null
  submit: boolean
}

const adjustmentArgs = (i: Omit<AdjustmentInput, 'submit'>) => ({
  p_adjustment_type: i.type, p_product_id: i.productId, p_location_id: i.locationId, p_reason_code: i.reasonCode, p_batch_id: i.batchId,
  p_batch_number: i.batchNumber, p_source_type: i.sourceType, p_counted_quantity: i.countedQuantity, p_correction_quantity: i.correctionQuantity,
  p_target_source_type: i.targetSourceType, p_unit_cost: i.unitCost, p_notes: i.notes, p_reference: i.reference, p_effective_date: i.effectiveDate,
})
/** Before migration 20261201090000 the reason is kept in the notes (the older functions have no reason field). */
const withReasonInNotes = (i: Omit<AdjustmentInput, 'submit'>) => ({ ...i, notes: i.reasonLabel ? [`Reason: ${i.reasonLabel}`, i.notes].filter(Boolean).join(' — ') : i.notes })

/** Records an adjustment as a draft or submitted for approval, with its configured reason. Stock does not change. */
export async function createAdjustment(i: AdjustmentInput, key: string) {
  try {
    return await rpc<{ adjustment_id: string; adjustment_number: string; status: string }>('inventory_create_adjustment_v2',
      { p_reason_label: i.reasonLabel ?? null, ...adjustmentArgs(i), p_submit: i.submit, p_idempotency_key: key })
  } catch (e) {
    if (!isMissingFunction(e)) throw e
    return rpc<{ adjustment_id: string; adjustment_number: string; status: string }>('inventory_create_adjustment',
      { ...adjustmentArgs(withReasonInNotes(i)), p_submit: i.submit, p_idempotency_key: key })
  }
}

/** V2 single-operator: record + post an adjustment in one step. A retry with the same key never posts twice. */
export async function postAdjustment(i: Omit<AdjustmentInput, 'submit'>, key: string) {
  type R = { adjustment_id: string; adjustment_number: string; status: string; transactions?: string[] }
  try {
    return await rpc<R>('inventory_post_adjustment_v2', { p_reason_label: i.reasonLabel ?? null, ...adjustmentArgs(i), p_idempotency_key: key })
  } catch (e) {
    if (!isMissingFunction(e)) throw e
    return rpc<R>('inventory_post_adjustment', { ...adjustmentArgs(withReasonInNotes(i)), p_idempotency_key: key })
  }
}

export const updateAdjustmentStatus = (id: string, action: 'SUBMIT' | 'CANCEL') =>
  rpc('inventory_update_adjustment_status', { p_adjustment_id: id, p_action: action })

export const reviewAdjustment = (id: string, decision: 'APPROVE' | 'REJECT', note: string | null, key: string) =>
  rpc<{ status: string; transactions: string[] }>('inventory_review_adjustment', { p_adjustment_id: id, p_decision: decision, p_note: note, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------
export async function fetchCounts(): Promise<CountRow[]> {
  const { data, error } = await db().from('inventory_counts').select('*').order('created_at', { ascending: false }).limit(500)
  if (error) throw error
  return data ?? []
}

export async function fetchCount(id: string): Promise<CountRow> {
  const { data, error } = await db().from('inventory_counts').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

export async function fetchCountLines(countId: string) {
  const { data, error } = await db().from('inventory_count_lines').select('*').eq('count_id', countId).order('created_at').limit(10000)
  if (error) throw error
  return enrichWithStock((data ?? []) as CountLineRow[])
}

export async function fetchAllCountLines() {
  const { data, error } = await db().from('inventory_count_lines').select('*').not('counted_quantity', 'is', null).limit(10000)
  if (error) throw error
  return enrichWithStock((data ?? []) as CountLineRow[])
}

export const createCount = (
  input: { warehouseId: string; locationId: string | null; includeSublocations: boolean; productIds: string[] | null; notes: string | null },
  key: string,
) =>
  rpc<{ count_id: string; count_number: string; line_count: number }>('inventory_create_count', {
    p_warehouse_id: input.warehouseId,
    p_location_id: input.locationId,
    p_include_sublocations: input.includeSublocations,
    p_product_ids: input.productIds,
    p_notes: input.notes,
    p_idempotency_key: key,
  })

export const recordCount = (countId: string, lines: { line_id: string; counted_quantity: number | null; notes?: string | null }[]) =>
  rpc<{ updated: number }>('inventory_record_count', { p_count_id: countId, p_lines: lines as unknown as Json })

export const addCountLine = (countId: string, input: { productId: string; locationId: string; sourceType: string; batchNumber: string | null; expiryDate: string | null }) =>
  rpc('inventory_add_count_line', {
    p_count_id: countId,
    p_product_id: input.productId,
    p_location_id: input.locationId,
    p_source_type: input.sourceType,
    p_batch_number: input.batchNumber,
    p_expiry_date: input.expiryDate,
  })

export const submitCount = (countId: string) => rpc('inventory_submit_count', { p_count_id: countId })
/** V2 single-operator: submit + post the count's variances in one step. */
export const postCount = (countId: string, note: string | null) =>
  rpc<{ status: string; adjustments_posted: number }>('inventory_post_count', { p_count_id: countId, p_note: note })
export const cancelCount = (countId: string) => rpc('inventory_cancel_count', { p_count_id: countId })
export const reviewCount = (countId: string, decision: 'APPROVE' | 'REJECT', note: string | null, key: string) =>
  rpc<{ status: string; adjustments_posted: number }>('inventory_review_count', { p_count_id: countId, p_decision: decision, p_note: note, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Alerts, reports, reconciliation
// ---------------------------------------------------------------------------
export const refreshAlerts = () => rpc<{ opened: number; resolved: number; active: number }>('inventory_refresh_alerts', {})

/** Stock register row by product (public.inventory_stock_position). Pending PO and production are never part of on hand. */
export interface StockPositionRow {
  product_id: string
  sku: string
  product_name: string
  category_id: string | null
  category_name: string | null
  product_type: string
  unit: string
  product_status: string
  on_hand: number
  reserved: number
  available: number
  pending_po_quantity: number
  open_po_count: number
  pending_production_quantity: number
  expected_incoming_quantity: number
  bom_required_quantity: number
  bom_shortage_quantity: number
  ledger_on_hand: number
  discrepancy: boolean
  stock_status: StockStatus | null
  low_stock: boolean
  reorder_level: number | null
  reorder_level_days: number | null
  lead_time_days: number | null
  last_movement_at: string | null
}
export interface StockPositionFilters {
  warehouse_id?: string | null
  category_id?: string | null
  product_type?: string | null
  search?: string
  include_inactive?: boolean
  shortage_only?: boolean
  pending_po_only?: boolean
  discrepancy_only?: boolean
  low_only?: boolean
}
export const fetchStockPosition = (filters: StockPositionFilters) =>
  rpc<{ warehouse_id: string | null; as_of: string; rows: StockPositionRow[] }>('inventory_stock_position', { p_filters: filters })

export interface StockPositionDetail {
  product: { id: string; sku: string; product_name: string; unit: string }
  locations: { warehouse_code: string; location_code: string; stock_usage: string; batch_number: string | null; source_type: string; on_hand: number; reserved: number; available: number; ledger_on_hand: number }[]
  purchase_orders: { id: string; po_number: string; status: string; supplier: string; expected: string | null; ordered: number; accepted: number; pending: number }[] | null
  goods_receipts: { id: string; receipt_number: string; date: string; status: string; po_number: string | null; accepted: number; rejected: number; supplier_invoice_number: string | null; supplier_challan_number: string | null }[] | null
  production_orders: { id: string; production_order_number: string; status: string; role: 'OUTPUT' | 'MATERIAL'; planned: number; completed?: number; pending?: number; issued?: number; reserved?: number }[] | null
  bom_components: { sku: string; product_name: string; unit: string; quantity_per_output: number; output_quantity: number; wastage_percentage: number; bom_code: string; version: number }[] | null
  used_in: { sku: string; product_name: string; bom_code: string; version: number; quantity_per_output: number; output_quantity: number; wastage_percentage: number }[] | null
  can_see_purchases: boolean
  can_see_production: boolean
}
export const fetchStockPositionDetail = (productId: string, warehouseId: string | null) =>
  rpc<StockPositionDetail>('inventory_stock_position_detail', { p_product_id: productId, p_warehouse_id: warehouseId })

export interface ReconciliationRow {
  product_id: string; sku: string; product_name: string; unit: string; warehouse_code: string | null; location_code: string | null; batch_number: string | null
  on_hand: number | null; ledger_on_hand: number; difference: number; reserved: number | null; active_reservations: number; problems: string[]
}
/** Lots / locations where balances, ledger or reservations disagree (public.inventory_reconciliation). */
export const fetchStockReconciliation = (productId: string | null = null) =>
  rpc<{ as_of: string; issues: number; rows: ReconciliationRow[]; checked_lots: number; checked_movements: number }>('inventory_reconciliation', { p_product_id: productId })

/** Day-based reorder planning (see public.inventory_reorder_plan). */
export interface ReorderPlanRow {
  product_id: string
  sku: string
  product_name: string
  unit: string
  product_type: string
  on_hand: number
  reserved: number
  available: number
  incoming: number
  open_orders: number
  consumed: number
  observed_days: number
  limited_history: boolean
  avg_daily: number | null
  coverage_days: number | null
  coverage_with_incoming_days: number | null
  lead_time_days: number | null
  reorder_level_days: number | null
  legacy_reorder_quantity: number | null
  runs_out_within_lead_time: boolean
  status: import('@/features/inventory/reorder-model').ReorderStatus
  suggested_quantity: number | null
}
export interface ReorderPlan {
  history_days: number
  as_of: string
  rows: ReorderPlanRow[]
  summary: { reorder: number; ok: number; no_consumption: number; not_configured: number }
}
export const fetchReorderPlan = (historyDays: number) => rpc<ReorderPlan>('inventory_reorder_plan', { p_history_days: historyDays })
export const acknowledgeAlert = (id: string, note: string | null) => rpc('inventory_acknowledge_alert', { p_alert_id: id, p_note: note })

export async function fetchAlerts(status: 'ACTIVE' | 'RESOLVED' | 'ALL'): Promise<AlertRow[]> {
  let query = db().from('inventory_alerts').select('*').order('last_detected_at', { ascending: false }).limit(2000)
  if (status === 'ACTIVE') query = query.in('status', ['OPEN', 'ACKNOWLEDGED'])
  if (status === 'RESOLVED') query = query.eq('status', 'RESOLVED')
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export const fetchStockAsOf = (cutoff: string) =>
  rpc<{ product_id: string; sku: string; product_name: string; unit: string; category_name: string | null; warehouse_code: string; warehouse_name: string; location_code: string; batch_number: string | null; source_type: string; quantity: number }[]>(
    'inventory_stock_as_of',
    { p_cutoff: cutoff },
  )

export const fetchValuation = () =>
  rpc<{ product_id: string; sku: string; product_name: string; unit: string; category_name: string | null; source_type: string; warehouse_code: string; location_code: string; batch_number: string | null; on_hand: number; unit_cost: number | null; value: number | null }[]>(
    'inventory_valuation',
    {},
  )

export interface ReconcileResult {
  checked: number
  checked_at: string
  mismatches: { sku: string; batch_number: string | null; source_type: string; location_code: string; balance_on_hand: number; ledger_on_hand: number; balance_reserved: number; reservations_open: number }[]
}

export const runReconciliation = () => rpc<ReconcileResult>('inventory_reconcile', {})

// Whole-piece (PCS) quantity audit: read only, never changes anything.
export type WholeUnitClassification =
  | 'NEEDS_CORRECTION' | 'THEORETICAL_RATIO' | 'INVALID_PLAN' | 'INVALID_PHYSICAL' | 'REVERSED_HISTORY' | 'ADJUSTMENT_HISTORY'

export interface WholeUnitFinding {
  category: string
  classification: WholeUnitClassification
  reference: string
  record_id: string
  link: string
  sku: string
  unit: string
  field: string
  value: number
  detail: string
}

export interface WholeUnitAudit {
  generated_at: string
  whole_units: string[]
  total: number
  summary: { category: string; classification: WholeUnitClassification; count: number }[]
  findings: WholeUnitFinding[]
  truncated: boolean
}

export const fetchWholeUnitAudit = () => rpc<WholeUnitAudit>('whole_unit_quantity_audit', {})

export async function fetchBatches() {
  const { data, error } = await db().from('inventory_batches').select('*').eq('is_system_lot', false).order('created_at', { ascending: false }).limit(5000)
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------------------
// Stock valuation (migration 20261125090000): the stock report rule, read-only
// ---------------------------------------------------------------------------
export interface ProductStockValuation {
  unit_cost: number | null
  stock_value: number | null
  valued_on_hand: number
  unvalued_on_hand: number
  valuation_status: 'VALUED' | 'PARTIAL' | 'NOT_VALUED' | 'NO_STOCK'
  /** Value of each lot in each location, by balance id. */
  lots: Map<string, { unit_cost: number | null; stock_value: number | null }>
}

/** One product's average inventory cost, stock value and the value of each lot/location, computed by the database. */
export async function fetchProductStockValuation(productId: string): Promise<ProductStockValuation> {
  // Views of migration 20261125090000 are not in the generated types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = db() as any
  const [p, l] = await Promise.all([
    client.from('inventory_product_stock_value').select('unit_cost, stock_value, valued_on_hand, unvalued_on_hand, valuation_status').eq('product_id', productId).maybeSingle(),
    client.from('inventory_balance_value').select('balance_id, unit_cost, stock_value').eq('product_id', productId).limit(2000),
  ])
  if (p.error) throw p.error
  if (l.error) throw l.error
  const row = (p.data ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    unit_cost: num(row.unit_cost),
    stock_value: num(row.stock_value),
    valued_on_hand: Number(row.valued_on_hand ?? 0),
    unvalued_on_hand: Number(row.unvalued_on_hand ?? 0),
    valuation_status: (row.valuation_status as ProductStockValuation['valuation_status']) ?? 'NO_STOCK',
    lots: new Map(((l.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.balance_id), { unit_cost: num(r.unit_cost), stock_value: num(r.stock_value) }])),
  }
}
