// Bulk delete of never-used products (Product Master → Missing Information). Pure TypeScript:
// the rules live in the database (public.product_bulk_delete, migration 20261121090000); this
// module only words the results and builds the downloadable report.

export const CONFIRM_PHRASE = 'DELETE PRODUCTS'

export interface ProductBlocker {
  label: string
  table: string
  count: number
}

/** One selected product as the database describes it (own company only). */
export interface BulkDeleteProduct {
  id: string
  sku: string
  product_name: string
  category: string | null
  standard_manufacturing_cost: number | null
  mrp: number | null
  hsn_code: string | null
  gst_rate: number | null
  status: 'ACTIVE' | 'INACTIVE'
  archived: boolean
  deletable: boolean
  blockers: ProductBlocker[]
  has_stock: boolean
  can_archive: boolean
}

export interface BulkDeletePreview {
  products: BulkDeleteProduct[]
  /** Selected ids that are not products of the user's company. */
  not_found: string[]
  deletable: number
  blocked: number
}

export interface BulkDeleteResult {
  status: 'COMPLETED' | 'FAILED' | 'DENIED'
  error: string | null
  request_id?: string
  deleted: Pick<BulkDeleteProduct, 'id' | 'sku' | 'product_name'>[]
  /** Protected products (kept), each with its blockers; archived_now when archived instead. */
  blocked: (BulkDeleteProduct & { archived_now: boolean; archive_error: string | null })[]
  /** Products not deleted because the operation failed and was rolled back. */
  failed: { id: string; sku: string; product_name: string; reason: string }[]
  not_found: string[]
}

export type DuplicateKind = 'name' | 'barcode' | 'ean' | 'model' | 'description'

export interface DuplicateHint {
  product_id: string
  kind: DuplicateKind
  matches: number
  match_skus: string[]
}

export const DUPLICATE_LABELS: Record<DuplicateKind, string> = {
  name: 'Same name',
  barcode: 'Same barcode',
  ean: 'Same EAN',
  model: 'Same model no.',
  description: 'Similar description',
}

/** "Same name as PB-2, PB-7 (+1)". */
export function duplicateText(h: DuplicateHint): string {
  const shown = h.match_skus.slice(0, 3).join(', ')
  const more = h.matches - Math.min(h.match_skus.length, 3)
  return `${DUPLICATE_LABELS[h.kind]} as ${shown}${more > 0 ? ` (+${more})` : ''}`
}

/** Why a product cannot be deleted, in plain words: "Linked to Sales invoices (2) and Stock ledger entries (4)". */
export function blockerText(blockers: ProductBlocker[]): string {
  if (blockers.length === 0) return ''
  const parts = blockers.map((b) => `${b.label} (${b.count})`)
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Linked to ${list}. Products with transactions or history are never deleted.`
}

export function confirmMessage(count: number): string {
  return `You are about to permanently delete ${count} selected ${count === 1 ? 'product' : 'products'}. Products linked to transactions will be protected. This operation cannot be undone.`
}

/** Every selected product that was not deleted, with the reason (the failed-record report). */
export function failedRecordReport(result: BulkDeleteResult, selected: Map<string, { sku: string; product_name: string }>): string[][] {
  const rows: string[][] = [['SKU', 'Product Name', 'Outcome', 'Reason']]
  for (const b of result.blocked) {
    const outcome = b.archived_now ? 'Archived instead (not deleted)' : 'Protected (not deleted)'
    const reason = [blockerText(b.blockers), b.archive_error ? `Not archived: ${b.archive_error}` : ''].filter(Boolean).join(' ')
    rows.push([b.sku, b.product_name, outcome, reason])
  }
  for (const f of result.failed) rows.push([f.sku, f.product_name, 'Failed', f.reason])
  for (const id of result.not_found) {
    const s = selected.get(id)
    rows.push([s?.sku ?? id, s?.product_name ?? '', 'Failed', 'Not found in your company (already deleted or not yours).'])
  }
  return rows
}
