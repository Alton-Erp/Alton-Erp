import { requireSupabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import type {
  AllocationStrategy,
  CustomerBillingFields,
  CustomerPoLineListRow,
  CustomerPoListRow,
  CustomerRow,
  PoAllocationListRow,
  PoAllocationRunRow,
  PoEventRow,
  PoImportBatchRow,
  PoSnapshotRow,
  PoStatus,
} from '@/types/database-customer-po'
import type { PoLinePayload } from '@/features/customer-po/po-import'

/**
 * Customer PO data access. Reads go through RLS-protected tables / views. The
 * file is parsed in the browser and never uploaded; only parsed rows, the file
 * name and its SHA-256 fingerprint are sent. Matching, availability and every
 * allocation are computed and validated by SECURITY DEFINER functions; nothing
 * calculated in the browser is trusted for stock.
 */

const db = () => requireSupabase()

async function rpc<T = Json>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export async function fetchCustomers(includeInactive = true): Promise<CustomerRow[]> {
  let query = db().from('customers').select('*').order('customer_name').limit(5000)
  if (!includeInactive) query = query.eq('status', 'ACTIVE')
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function createCustomer(
  companyId: string,
  input: { code: string; name: string; email: string | null; notes: string | null; billing?: Partial<CustomerBillingFields> },
): Promise<CustomerRow> {
  const { data, error } = await db()
    .from('customers')
    .insert({ company_id: companyId, customer_code: input.code, customer_name: input.name, contact_email: input.email, notes: input.notes, ...(input.billing ?? {}) })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function updateCustomer(
  id: string,
  changes: { customer_name?: string; contact_email?: string | null; status?: 'ACTIVE' | 'INACTIVE'; notes?: string | null } & Partial<CustomerBillingFields>,
) {
  const { error, count } = await db().from('customers').update(changes, { count: 'exact' }).eq('id', id)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

export const fetchCustomerOptions = () => rpc<{ customer_key: string; customer_name: string; customer_id: string | null }[]>('customer_po_customer_options', {})

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
export interface PoHeaderInput {
  customer_id: string | null
  customer_name: string | null
  customer_po_number: string
  po_date: string
  required_delivery_date: string | null
  currency: string | null
  notes: string | null
  fulfilment_warehouse_id: string | null
}

export interface PreviewLine {
  source_row_number: number
  status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'INVALID' | 'DUPLICATE_REVIEW'
  reason: string | null
  method: string | null
  note: string | null
  product_id: string | null
  sku: string | null
  product_name: string | null
  base_unit: string | null
  duplicate_of_row: string | null
  candidates: { product_id: string; sku: string; product_name: string }[]
  in_house_available: number | null
  outsourced_available: number | null
  unknown_on_hand: number | null
  available_for_line: number | null
  availability_status: string
}

export interface PoPreview {
  customer_id: string | null
  customer_name: string
  duplicate_po: { po_id: string; po_reference: string; revision: number; status: PoStatus; customer_name: string } | null
  duplicate_file: { po_id: string; po_reference: string; customer_po_number: string; revision: number } | null
  lines: PreviewLine[]
}

export const previewPo = (header: PoHeaderInput, lines: PoLinePayload[], fileHash: string | null) =>
  rpc<PoPreview>('customer_po_preview', { p_header: header, p_lines: lines, p_file_hash: fileHash })

export type ImportResult =
  | { ok: true; po_id: string; po_reference: string; revision: number; status: PoStatus; lines: number; matched: number; unmatched: number; ambiguous: number; invalid: number; duplicate_review: number; duplicate?: boolean }
  | { ok: false; reason: 'DUPLICATE_PO' | 'DUPLICATE_FILE'; existing: { po_id: string; po_reference: string; revision: number; status: PoStatus; customer_po_number?: string }; duplicate?: boolean }
  | { ok: false; reason: 'INVALID'; errors: { row: string | null; message: string }[]; duplicate?: boolean }

export const importPo = (
  header: PoHeaderInput,
  lines: PoLinePayload[],
  file: { name: string; hash: string | null; size: number; sheet: string | null; rows_read: number; rejected_rows: { row: number; message: string }[] },
  revisionOf: string | null,
  key: string,
) => rpc<ImportResult>('customer_po_import', { p_header: header, p_lines: lines, p_file: file, p_revision_of: revisionOf, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// POs and lines
// ---------------------------------------------------------------------------
export interface PoListFilters {
  status: PoStatus | 'OPEN' | 'REVIEW' | null
  currentOnly: boolean
  customerKey?: string | null
  from?: string | null
  to?: string | null
}

export async function fetchPos(filters: PoListFilters): Promise<CustomerPoListRow[]> {
  let query = db().from('customer_po_list').select('*').order('created_at', { ascending: false }).limit(3000)
  if (filters.currentOnly) query = query.eq('is_current', true)
  if (filters.status === 'OPEN') query = query.not('status', 'in', '(CANCELLED,FULFILLED)')
  else if (filters.status === 'REVIEW') query = query.in('status', ['UPLOADED', 'VALIDATION_REQUIRED', 'PRODUCT_MATCHING_REQUIRED'])
  else if (filters.status) query = query.eq('status', filters.status)
  if (filters.customerKey) query = query.eq('customer_key', filters.customerKey)
  if (filters.from) query = query.gte('po_date', filters.from)
  if (filters.to) query = query.lte('po_date', filters.to)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as CustomerPoListRow[]
}

export async function fetchPo(id: string): Promise<CustomerPoListRow> {
  const { data, error } = await db().from('customer_po_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as CustomerPoListRow
}

export async function fetchPoLines(filters: { poId?: string | null; statuses?: string[]; flaggedOnly?: boolean }): Promise<CustomerPoLineListRow[]> {
  let query = db().from('customer_po_line_list').select('*').order('purchase_order_id').order('line_no').limit(10000)
  if (filters.poId) query = query.eq('purchase_order_id', filters.poId)
  if (filters.statuses?.length) query = query.in('line_status', filters.statuses as CustomerPoLineListRow['line_status'][])
  if (filters.flaggedOnly) query = query.eq('flagged_for_new_product', true)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as CustomerPoLineListRow[]
}

export async function fetchProductsByIds(ids: string[]) {
  if (ids.length === 0) return []
  const { data, error } = await db().from('products').select('id, sku, product_name, base_unit, status').in('id', ids)
  if (error) throw error
  return data ?? []
}

export type LineAction = 'MATCH' | 'CONFIRM_DUPLICATE' | 'EXCLUDE' | 'RESTORE' | 'FLAG_NEW_PRODUCT' | 'UNFLAG' | 'CORRECT'
export const poLineAction = (input: { lineId: string; action: LineAction; productId?: string | null; remember?: boolean; note?: string | null; quantity?: number | null; unit?: string | null }) =>
  rpc<{ line_status: string; po_status: PoStatus }>('customer_po_line_action', {
    p_line_id: input.lineId,
    p_action: input.action,
    p_product_id: input.productId ?? null,
    p_remember: input.remember ?? false,
    p_note: input.note ?? null,
    p_quantity: input.quantity ?? null,
    p_unit: input.unit ?? null,
  })

export const rematchPo = (poId: string) => rpc<{ lines_changed: number; po_status: PoStatus }>('customer_po_rematch', { p_po_id: poId })

export const poAction = (poId: string, action: 'HOLD' | 'RESUME' | 'CANCEL', note: string | null) =>
  rpc<{ status: PoStatus; released_quantity: number }>('customer_po_action', { p_po_id: poId, p_action: action, p_note: note })

export const updatePoHeader = (poId: string, input: { requiredDeliveryDate: string | null; fulfilmentWarehouseId: string | null; notes: string | null }) =>
  rpc('customer_po_update_header', {
    p_po_id: poId,
    p_required_delivery_date: input.requiredDeliveryDate,
    p_fulfilment_warehouse_id: input.fulfilmentWarehouseId,
    p_notes: input.notes,
  })

// ---------------------------------------------------------------------------
// Availability, allocation, dispatch
// ---------------------------------------------------------------------------
export interface AnalysisLine {
  line_id: string
  purchase_order_id: string
  line_no: number
  source_row_number: number
  uploaded_sku: string | null
  uploaded_customer_sku: string | null
  uploaded_description: string | null
  product_id: string | null
  sku: string | null
  product_name: string | null
  category_name: string | null
  base_unit: string | null
  line_unit: string | null
  default_source_type: string | null
  reorder_level: number | null
  line_status: string
  status_reason: string | null
  quantity_ordered: number
  quantity_dispatched: number
  allocated_open: number
  remaining_need: number
  on_hand: number
  reserved: number
  available: number
  in_house_on_hand: number
  in_house_reserved: number
  in_house_available: number
  outsourced_on_hand: number
  outsourced_reserved: number
  outsourced_available: number
  unknown_on_hand: number
  ineligible_on_hand: number
  other_warehouse_available: number
  available_for_line: number
  shortage_before: number | null
  shortage_after: number | null
  availability_status: string
  review_warning: string | null
  shortage_status: string
  shortage_priority: string
  shortage_owner: string | null
}

export interface PoAnalysis {
  availability_status: string
  lines: AnalysisLine[]
  review_warnings: number
  units: { unit: string; ordered: number; dispatched: number; allocated: number; available_for_lines: number; shortage_before: number; shortage_after: number }[]
  calculated_at: string
}

export const fetchPoAnalysis = (poId: string) => rpc<PoAnalysis>('customer_po_analysis', { p_po_id: poId })

export interface LotStock {
  balance_id: string
  batch_id: string
  batch_number: string | null
  source_type: string
  warehouse_id: string
  warehouse_code: string
  location_id: string
  location_code: string
  stock_usage: string
  expiry_date: string | null
  on_hand: number
  reserved: number
  available: number
  eligible: boolean
  ineligible_reason: string | null
  reserved_for_line: number
}

export const fetchLineStock = (lineId: string) => rpc<LotStock[]>('customer_po_line_stock', { p_line_id: lineId })

export interface PlanEntry {
  line_id: string
  balance_id: string
  quantity: number
  batch_id?: string
  batch_number?: string | null
  source_type?: string
  warehouse_id?: string
  warehouse_code?: string
  location_id?: string
  location_code?: string
  expiry_date?: string | null
}

export const proposeAllocation = (poId: string, strategy: Exclude<AllocationStrategy, 'MANUAL'>, warehousePriority: string[] | null) =>
  rpc<PlanEntry[]>('customer_po_propose', { p_po_id: poId, p_strategy: strategy, p_warehouse_priority: warehousePriority })

export interface AllocateResult {
  reservations: { reservation_number: string; line_id: string; quantity: number; source_type: string; warehouse_code: string; location_code: string; batch_number: string | null }[]
  shortages: { line_no: number; sku: string; short: number; unit: string }[]
  status: PoStatus
  duplicate?: boolean
}

export const allocatePo = (
  input: { poId: string; strategy: AllocationStrategy; warehousePriority: string[] | null; manual: { line_id: string; balance_id: string; quantity: number }[] | null; allowPartial: boolean; note: string | null },
  key: string,
) =>
  rpc<AllocateResult>('customer_po_allocate', {
    p_po_id: input.poId,
    p_strategy: input.strategy,
    p_warehouse_priority: input.warehousePriority,
    p_manual: input.manual,
    p_allow_partial: input.allowPartial,
    p_note: input.note,
    p_idempotency_key: key,
  })

export const savePlanDraft = (poId: string, strategy: AllocationStrategy, plan: PlanEntry[], note: string | null) =>
  rpc<{ run_id: string }>('customer_po_save_plan', { p_po_id: poId, p_strategy: strategy, p_plan: plan, p_note: note })

export const releasePo = (poId: string, lineId: string | null, reservationId: string | null, note: string | null) =>
  rpc<{ released_quantity: number; reservations: number; status: PoStatus }>('customer_po_release', {
    p_po_id: poId,
    p_line_id: lineId,
    p_reservation_id: reservationId,
    p_note: note,
  })

export const dispatchPo = (poId: string, items: { reservation_id: string; quantity: number }[], reference: string | null, notes: string | null, key: string) =>
  rpc<{ transaction_numbers: string[]; status: PoStatus }>('customer_po_dispatch', { p_po_id: poId, p_items: items, p_reference: reference, p_notes: notes, p_idempotency_key: key })

export const reverseDispatch = (transactionId: string, reason: string, key: string) =>
  rpc<{ reversal_numbers: string[]; status: PoStatus }>('customer_po_reverse_dispatch', { p_transaction_id: transactionId, p_reason: reason, p_idempotency_key: key })

export async function fetchPoAllocations(filters: { poId?: string | null; openOnly?: boolean }): Promise<PoAllocationListRow[]> {
  let query = db().from('customer_po_allocation_list').select('*').order('reserved_at', { ascending: false }).limit(5000)
  if (filters.poId) query = query.eq('purchase_order_id', filters.poId)
  if (filters.openOnly) query = query.in('reservation_status', ['ACTIVE', 'PARTIALLY_FULFILLED'])
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as PoAllocationListRow[]
}

export async function fetchPoDispatches(poId: string) {
  const { data, error } = await db()
    .from('inventory_transaction_list')
    .select('id, transaction_number, transaction_type, quantity, unit, sku, product_name, batch_number, warehouse_code, location_code, transaction_date, reference_id, reversed_by_number')
    .eq('document_type', 'CUSTOMER_PO')
    .eq('document_id', poId)
    .eq('transaction_type', 'ISSUE')
    .order('transaction_date', { ascending: false })
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------------------
// History, snapshots, revisions, shortages, dashboard
// ---------------------------------------------------------------------------
export async function fetchPoEvents(poId: string | null): Promise<PoEventRow[]> {
  let query = db().from('customer_po_events').select('*').order('created_at', { ascending: false }).limit(3000)
  if (poId) query = query.eq('purchase_order_id', poId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function fetchAllocationRuns(poId: string | null): Promise<PoAllocationRunRow[]> {
  let query = db().from('customer_po_allocation_runs').select('*').order('created_at', { ascending: false }).limit(2000)
  if (poId) query = query.eq('purchase_order_id', poId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function fetchSnapshots(poId: string): Promise<PoSnapshotRow[]> {
  const { data, error } = await db().from('customer_po_analysis_snapshots').select('*').eq('purchase_order_id', poId).order('taken_at', { ascending: false }).limit(50)
  if (error) throw error
  return data ?? []
}

export async function fetchImportBatches(): Promise<PoImportBatchRow[]> {
  const { data, error } = await db().from('customer_po_import_batches').select('*').order('uploaded_at', { ascending: false }).limit(1000)
  if (error) throw error
  return data ?? []
}

export const refreshAnalysis = (poId: string) => rpc<{ snapshot_id: string; taken_at: string }>('customer_po_refresh_analysis', { p_po_id: poId })

export const fetchRevisionDiff = (poId: string) =>
  rpc<{
    previous_revision: { po_id: string; po_reference: string; revision: number; status: PoStatus } | null
    changes: { code: string; previous_quantity: number | null; new_quantity: number | null; previous_reserved: number; change: 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED' }[]
  }>('customer_po_revision_diff', { p_po_id: poId })

export interface ShortageRow {
  po_id: string
  po_reference: string
  customer_name: string
  customer_key: string
  customer_po_number: string
  revision: number
  po_date: string
  required_delivery_date: string | null
  po_status: PoStatus
  warehouse_code: string | null
  line_id: string
  line_no: number
  product_id: string
  sku: string
  product_name: string
  category_name: string | null
  unit: string
  quantity_ordered: number
  quantity_dispatched: number
  allocated: number
  available: number
  shortage: number
  shortage_before: number
  in_house_available: number
  outsourced_available: number
  other_warehouse_available: number
  unknown_on_hand: number
  shortage_status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED'
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  owner: string | null
  last_note: string | null
  suggested_actions: string[]
}

export const fetchShortages = (filters: { from: string | null; to: string | null; customerKey: string | null }) =>
  rpc<ShortageRow[]>('customer_po_shortages', { p_from: filters.from, p_to: filters.to, p_customer_key: filters.customerKey })

export const updateShortage = (lineId: string, status: string, priority: string, owner: string | null, note: string | null) =>
  rpc('customer_po_update_shortage', { p_line_id: lineId, p_status: status, p_priority: priority, p_owner: owner, p_note: note })

export async function fetchShortageNotes(lineId: string) {
  const { data, error } = await db().from('customer_po_shortage_notes').select('*').eq('line_id', lineId).order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export const fetchAssignableUsers = () => rpc<{ user_id: string; display_name: string }[]>('customer_po_assignable_users', {})

export interface PoDashboard {
  has_records: boolean
  total_received: number
  pending_review: number
  ready_for_fulfilment: number
  partially_available: number
  with_shortages: number
  fully_allocated: number
  units: { unit: string; ordered: number; need: number; available: number; reserved_for_pos: number; shortage: number; in_house_available: number; outsourced_available: number; unknown_on_hand: number }[]
  by_status: { status: PoStatus; count: number }[]
  top_products: { sku: string; product_name: string; unit: string; ordered: number; available: number; shortage: number }[]
  shortage_by_category: { category: string; unit: string; shortage: number }[]
  received_over_time: { bucket: string; count: number }[]
  timezone: string
  as_of: string
}

export const fetchPoDashboard = (filters: { from: string; to: string; customerKey: string | null; status: string | null; productId: string | null; warehouseId: string | null; bucket: 'day' | 'week' | 'month' | 'year' }) =>
  rpc<PoDashboard>('customer_po_dashboard', {
    p_from: filters.from,
    p_to: filters.to,
    p_customer_key: filters.customerKey,
    p_status: filters.status,
    p_product_id: filters.productId,
    p_warehouse_id: filters.warehouseId,
    p_bucket: filters.bucket,
  })
