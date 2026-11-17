import { cleanLine } from '@/features/production/bom-bulk-model'
import { requireSupabase } from '@/lib/supabase'

/**
 * Bulk BOM management (migration 20261218090000). Every call goes through a
 * SECURITY DEFINER function that checks the company and the production_bom.*
 * permissions; the change tables are read-only for the app.
 */

export type BulkOperation = 'REPLACE' | 'DELETE' | 'ADD' | 'EDIT' | 'RESTORE'
export type BatchStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PUBLISHED' | 'CANCELLED'
export type WhereUsedStatus = 'CURRENT' | 'ACTIVE' | 'SCHEDULED' | 'DRAFT' | 'PENDING_APPROVAL' | 'REJECTED' | 'SUPERSEDED' | 'ARCHIVED' | 'ALL'
export type WhereUsedSort = 'sku' | 'product_name' | 'bom_code' | 'quantity' | 'wastage' | 'status' | 'effective_from' | 'unit'

export interface ComponentHit {
  product_id: string
  sku: string
  product_name: string
  base_unit: string
  product_type: string
  status: string
  barcode: string | null
  ean: string | null
  model_number: string | null
  supplier_model_number: string | null
  bom_lines: number
}

export interface WhereUsedRow {
  bom_id: string
  bom_code: string
  version: number
  status: string
  lifecycle: string
  is_current: boolean
  effective_from: string
  effective_to: string | null
  output_quantity: number
  output_unit: string
  finished_product_id: string
  sku: string
  product_name: string
  product_type: string
  finished_status: string
  line_no: number
  component_product_id: string
  component_sku: string
  component_name: string
  quantity: number
  unit: string
  inventory_unit: string
  unit_matches: boolean
  wastage_percentage: number
  notes: string | null
  source_type: string | null
  quantity_per_unit: number
}

export interface WhereUsedResult {
  component: { product_id: string; sku: string; product_name: string; base_unit: string; product_type: string; status: string; barcode: string | null; ean: string | null }
  total: number
  rows: WhereUsedRow[]
  stats: { current_boms: number; products: number; total_quantity_current: number; unit_mismatches: number }
}

export interface CurrentBom {
  bom_id: string
  bom_code: string
  version: number
  lifecycle: string
  effective_from: string
  finished_product_id: string
  sku: string
  product_name: string
  product_type: string
  item_count: number
}

export interface ResolvedSku {
  sku_key: string
  product_id: string
  sku: string
  product_name: string
  base_unit: string
  product_type: string
  status: string
  current_bom_id: string | null
  current_bom_code: string | null
  current_version: number | null
}

export interface BatchSummary {
  boms?: number
  boms_valid?: number
  lines?: number
  lines_with_errors?: number
  lines_with_warnings?: number
  products_with_errors?: { finished_product_id: string | null; sku: string | null; name: string | null; errors: string[] }[]
  evaluated_at?: string
}

export interface Batch {
  id: string
  batch_number: string
  operation: BulkOperation
  status: BatchStatus
  title: string | null
  reason: string
  effective_from: string
  merge_duplicates: boolean
  restores_batch_id: string | null
  restores_batch_number?: string | null
  summary: BatchSummary
  row_version: number
  last_error: string | null
  created_at: string
  created_by_name?: string | null
  submitted_at: string | null
  submitted_by_name?: string | null
  approved_at: string | null
  approved_by_name?: string | null
  approval_note: string | null
  rejected_at: string | null
  rejected_by_name?: string | null
  rejection_reason: string | null
  published_at: string | null
  published_by_name?: string | null
  stale?: boolean
}

export interface BatchLine {
  id: string
  line_no: number
  action: BulkOperation
  source_bom_id: string
  bom_code: string | null
  source_version: number | null
  finished_product_id: string | null
  finished_sku: string | null
  finished_name: string | null
  component_product_id: string | null
  component_sku: string | null
  component_name: string | null
  new_component_product_id: string | null
  new_component_sku: string | null
  new_component_name: string | null
  restore_from_bom_id: string | null
  input: Record<string, unknown>
  old_quantity: number | null
  new_quantity: number | null
  old_unit: string | null
  new_unit: string | null
  old_wastage: number | null
  new_wastage: number | null
  old_notes: string | null
  new_notes: string | null
  validation_errors: string[]
  warnings: string[]
  result_bom_id: string | null
  result_version: number | null
}

export interface ImpactOrder {
  production_order_id: string
  production_order_number: string
  status: string
  sku: string
  product_name: string
  bom_code: string
  bom_version: number
  planned_quantity: number
  unit: string
  planned_start_date: string
  released: boolean
  effect: string
}

export interface ImpactComponent {
  product_id: string
  sku: string
  product_name: string
  unit: string
  roles: string
  boms_in_batch: number
  current_boms: number
  current_boms_after: number
  on_hand: number | null
  reserved: number | null
  available: number | null
  open_po_quantity: number | null
  open_po_count: number | null
  consumed_90_days: number | null
  open_order_requirement: number | null
}

export interface BatchImpact {
  production_orders: ImpactOrder[] | null
  production_orders_visible: boolean
  components: ImpactComponent[]
  stock_visible: boolean
  purchases_visible: boolean
  effective_from: string
  note: string
}

export interface BatchEvent {
  action: string
  acted_at: string
  note: string | null
  details: Record<string, unknown>
  actor_name: string | null
}

export interface BatchDetail {
  batch: Batch
  lines: BatchLine[]
  impact: BatchImpact | null
  events: BatchEvent[]
  permissions: { can_edit: boolean; can_approve: boolean; can_publish: boolean; self_approval_blocked: boolean }
}

export interface BatchListRow {
  id: string
  batch_number: string
  operation: BulkOperation
  status: BatchStatus
  title: string | null
  reason: string
  effective_from: string
  summary: BatchSummary
  created_at: string
  created_by_name: string | null
  submitted_at: string | null
  approved_at: string | null
  published_at: string | null
  approved_by_name: string | null
  stale: boolean
  last_error: string | null
}

export interface RevisionRow {
  bom_id: string
  bom_code: string
  version: number
  status: string
  lifecycle: string
  effective_from: string
  effective_to: string | null
  finished_product_id: string
  sku: string
  product_name: string
  change_reason: string | null
  review_note: string | null
  created_at: string
  approved_at: string | null
  created_by_name: string | null
  approved_by_name: string | null
  previous_bom_id: string | null
  item_count: number
  batch_id: string | null
  batch_number: string | null
  batch_operation: BulkOperation | null
}

/** One requested change; ids only, the server reads the current values. */
export interface BatchLineInput {
  bom_id?: string
  finished_product_id?: string
  component_product_id: string
  new_component_product_id?: string
  quantity?: number | string | null
  factor?: number | string | null
  unit?: string | null
  wastage_percentage?: number | string | null
  notes?: string | null
  source_type?: string | null
}

export interface BatchHeader {
  operation: Exclude<BulkOperation, 'RESTORE'>
  reason: string
  effective_from: string
  title?: string
  merge_duplicates?: boolean
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export const searchComponents = (term: string, limit = 20) => rpc<ComponentHit[]>('bom_component_search', { p_term: term, p_limit: limit })

export const fetchWhereUsed = (component: string, filters: { status?: WhereUsedStatus; search?: string; product_type?: string }, sort: WhereUsedSort, ascending: boolean, limit: number, offset: number) =>
  rpc<WhereUsedResult>('bom_where_used', { p_component: component, p_filters: filters, p_sort: sort, p_ascending: ascending, p_limit: limit, p_offset: offset })

export const fetchCurrentBoms = (search: string | null, limit = 500) => rpc<CurrentBom[]>('bom_bulk_current_boms', { p_search: search, p_limit: limit })

export const resolveSkus = (skus: string[]) => rpc<ResolvedSku[]>('bom_bulk_resolve_skus', { p_skus: skus })

export const saveBatch = (batchId: string | null, expectedVersion: number | null, header: BatchHeader, lines: BatchLineInput[]) =>
  rpc<BatchDetail>('bom_change_batch_save', { p_batch_id: batchId, p_expected_version: expectedVersion, p_header: header, p_lines: lines.map(cleanLine) })

export const removeBatchLines = (batchId: string, expectedVersion: number, lineIds: string[]) =>
  rpc<BatchDetail>('bom_change_batch_remove_lines', { p_batch_id: batchId, p_expected_version: expectedVersion, p_line_ids: lineIds })

export const validateBatch = (batchId: string) => rpc<BatchDetail>('bom_change_batch_validate', { p_batch_id: batchId })

export const fetchBatch = (batchId: string) => rpc<BatchDetail>('bom_change_batch_get', { p_batch_id: batchId })

export type BatchAction = 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'CANCEL'
export const batchAction = (batchId: string, action: BatchAction, note: string | null, expectedVersion: number | null) =>
  rpc<BatchDetail>('bom_change_batch_action', { p_batch_id: batchId, p_action: action, p_note: note, p_expected_version: expectedVersion })

export interface PublishResult {
  ok: boolean
  message?: string
  already_published?: boolean
  revisions?: { bom_code: string; from_version: number; to_version: number; bom_id: string }[]
  batch: BatchDetail
}
export const publishBatch = (batchId: string, expectedVersion: number | null, idempotencyKey: string) =>
  rpc<PublishResult>('bom_change_batch_publish', { p_batch_id: batchId, p_expected_version: expectedVersion, p_idempotency_key: idempotencyKey })

export const createReversal = (batchId: string, reason: string, effectiveFrom: string | null) =>
  rpc<BatchDetail>('bom_change_batch_create_reversal', { p_batch_id: batchId, p_reason: reason, p_effective_from: effectiveFrom })

export const fetchBatches = (status: BatchStatus | null, limit = 200, offset = 0) =>
  rpc<{ total: number; counts: Partial<Record<BatchStatus, number>>; rows: BatchListRow[] }>('bom_change_batches_list', { p_status: status, p_limit: limit, p_offset: offset })

export const fetchRevisionLog = (filters: { search?: string; source?: 'ALL' | 'BULK' | 'MANUAL'; from?: string; to?: string; product_id?: string }, limit: number, offset: number) =>
  rpc<{ total: number; rows: RevisionRow[] }>('bom_revision_log', { p_filters: filters, p_limit: limit, p_offset: offset })
