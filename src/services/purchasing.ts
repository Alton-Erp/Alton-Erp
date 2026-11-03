import { requireSupabase } from '@/lib/supabase'
import type {
  GoodsReceiptLineListRow,
  GoodsReceiptListRow,
  PurchaseOrderAmendmentRow,
  PurchaseOrderEventRow,
  PurchaseOrderLineListRow,
  PurchaseOrderListRow,
} from '@/types/database-purchasing'
import type { SupplierPaymentTerms } from '@/types/database-suppliers'

/**
 * Supplier purchase orders and goods receipts. Reads go through RLS-protected
 * tables / views (purchases.read). Every change is a SECURITY DEFINER RPC that
 * takes the company from the signed-in user, checks permissions and
 * recalculates totals: nothing calculated in the browser is trusted.
 */
const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const PO_LIST_LIMIT = 2000

export async function fetchPurchaseOrders(filter: { supplierId?: string } = {}): Promise<PurchaseOrderListRow[]> {
  let q = db().from('purchase_order_list_v2').select('*').order('po_date', { ascending: false }).order('po_number', { ascending: false }).limit(PO_LIST_LIMIT)
  if (filter.supplierId) q = q.eq('supplier_id', filter.supplierId)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function fetchPurchaseOrder(id: string): Promise<PurchaseOrderListRow> {
  const { data, error } = await db().from('purchase_order_list_v2').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

export async function fetchPoLines(poId: string): Promise<PurchaseOrderLineListRow[]> {
  const { data, error } = await db().from('purchase_order_line_list').select('*').eq('purchase_order_id', poId).order('line_no')
  if (error) throw error
  return data ?? []
}

export async function fetchPoEvents(poId: string): Promise<PurchaseOrderEventRow[]> {
  const { data, error } = await db().from('purchase_order_events').select('*').eq('purchase_order_id', poId).order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function fetchPoAmendments(poId: string): Promise<PurchaseOrderAmendmentRow[]> {
  const { data, error } = await db().from('purchase_order_amendments').select('*').eq('purchase_order_id', poId).order('to_revision', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function fetchGoodsReceipts(filter: { poId?: string; supplierId?: string } = {}): Promise<GoodsReceiptListRow[]> {
  let q = db().from('goods_receipt_list_v2').select('*').order('receipt_date', { ascending: false }).order('receipt_number', { ascending: false }).limit(PO_LIST_LIMIT)
  if (filter.poId) q = q.eq('purchase_order_id', filter.poId)
  if (filter.supplierId) q = q.eq('supplier_id', filter.supplierId)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function fetchReceiptLines(poId: string): Promise<GoodsReceiptLineListRow[]> {
  const { data, error } = await db().from('goods_receipt_line_list').select('*').eq('purchase_order_id', poId).order('created_at')
  if (error) throw error
  return data ?? []
}

export interface PoDashboard {
  total: number
  by_status: Partial<Record<string, number>>
  open: number
  overdue: number
  period_value: number
  period_orders: number
  outstanding_receipt_value: number
  generated_at: string
}

export const fetchPoDashboard = (from: string, to: string) => rpc<PoDashboard>('purchase_order_dashboard', { p_from: from, p_to: to })

export interface PoSupplierOption {
  id: string
  supplier_code: string
  legal_name: string
  display_name: string | null
  category: string
  gstin: string | null
  state_code: string | null
  country: string
  payment_terms: SupplierPaymentTerms
  custom_payment_days: number | null
  billing_address: string | null
  shipping_address: string | null
  contact_person: string | null
  email: string | null
  phone: string | null
}

/** Active suppliers of the user's company (requires purchase_order.create / update). */
export const fetchPoSupplierOptions = () => rpc<PoSupplierOption[]>('purchase_supplier_options', {})

export interface PoProductOption {
  id: string
  sku: string
  product_name: string
  base_unit: string
  hsn_code: string | null
  gst_rate: number | null
  standard_cost: number | null
  status: string
}

/** Product Master search for PO lines (active, not archived). */
export async function searchPoProducts(term: string): Promise<PoProductOption[]> {
  const clean = term.replace(/[^\p{L}\p{N} ._/-]/gu, ' ').trim().slice(0, 60)
  let q = db().from('products').select('id, sku, product_name, base_unit, hsn_code, gst_rate, standard_cost, status')
    .is('archived_at', null).eq('status', 'ACTIVE').order('sku').limit(15)
  if (clean) q = q.or(`sku.ilike.%${clean}%,product_name.ilike.%${clean}%,barcode.ilike.%${clean}%`)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as PoProductOption[]
}

export const validatePurchaseOrder = (poId: string) => rpc<{ code: string; message: string; line_no?: number }[]>('purchase_order_validate', { p_po_id: poId })

// ---------------------------------------------------------------------------
// Writes (RPCs)
// ---------------------------------------------------------------------------
export interface PoHeaderInput {
  supplier_id: string
  po_date: string
  expected_delivery_date: string | null
  warehouse_id: string | null
  purchase_type: string
  payment_terms: string | null
  custom_payment_days: number | null
  reference_number: string | null
  delivery_instructions: string | null
  internal_notes: string | null
  purchase_conditions: string | null
}

/** Supplier's invoice and challan numbers (separate from Alton's PO and GRN numbers). */
export interface SupplierDocumentRefs {
  supplier_invoice_number: string | null
  supplier_challan_number: string | null
}

/** Saves the order and its order-level supplier references in one transaction (a duplicate supplier invoice refuses both). */
export const savePurchaseOrder = (poId: string | null, header: PoHeaderInput, lines: unknown[], expectedUpdatedAt: string | null, requestKey: string | null,
  refs: SupplierDocumentRefs | null = null) =>
  rpc<{ po_id: string; po_number: string; status: string; updated_at: string; grand_total: number; duplicate?: boolean }>('purchase_order_save_refs', {
    p_po_id: poId, p_header: header, p_lines: lines, p_expected_updated_at: expectedUpdatedAt, p_idempotency_key: requestKey, p_refs: refs,
  })

/** Adds or corrects the supplier references of an order (poId) or of one goods receipt (receiptId), e.g. when the invoice arrives. */
export const setSupplierDocumentRefs = (target: { poId: string } | { receiptId: string }, refs: Partial<SupplierDocumentRefs>) =>
  rpc<SupplierDocumentRefs & { changed: boolean }>('purchase_document_refs_set', {
    p_purchase_order_id: 'poId' in target ? target.poId : null, p_goods_receipt_id: 'receiptId' in target ? target.receiptId : null, p_refs: refs,
  })

export type PoWorkflowAction = 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'SEND' | 'AMEND' | 'CANCEL' | 'CLOSE'

export const purchaseOrderAction = (poId: string, action: PoWorkflowAction, note: string | null, expectedUpdatedAt: string | null) =>
  rpc<{ po_id: string; status: string; updated_at: string }>('purchase_order_action', {
    p_po_id: poId, p_action: action, p_note: note, p_expected_updated_at: expectedUpdatedAt,
  })

/** V2 single-operator: submit + approve in one step, so the order is open for goods receipt. */
export const openPurchaseOrder = (poId: string, expectedUpdatedAt: string | null) =>
  rpc<{ po_id: string; status: string; updated_at: string }>('purchase_order_open', {
    p_po_id: poId, p_expected_updated_at: expectedUpdatedAt,
  })

export interface ReceiptLineInput {
  po_line_id: string
  received_quantity: string
  accepted_quantity: string
  rejected_quantity: string
  accepted_location_id: string | null
  rejected_location_id: string | null
  batch_number: string | null
  manufacturing_date: string | null
  expiry_date: string | null
  serial_numbers: string | null
  rejection_reason: string | null
  over_receipt_reason: string | null
}

export const postGoodsReceipt = (
  poId: string,
  header: { receipt_date: string; supplier_document_number: string | null; supporting_document_ref: string | null; notes: string | null } & SupplierDocumentRefs,
  lines: ReceiptLineInput[],
  requestKey: string,
) =>
  rpc<{ receipt_id: string; receipt_number: string; po_status: string; transaction_numbers: string[]; duplicate?: boolean }>('purchase_receipt_post_refs', {
    p_po_id: poId, p_header: header, p_lines: lines, p_idempotency_key: requestKey,
  })

/** Reverses any goods receipt (against a PO or direct); stock received must still be there. */
export const reverseGoodsReceipt = (receiptId: string, reason: string, requestKey: string) =>
  rpc<{ reversal_numbers: string[]; po_status: string | null }>('goods_receipt_reverse', { p_receipt_id: receiptId, p_reason: reason, p_idempotency_key: requestKey })

export interface DirectReceiptLineInput {
  product_id: string
  received_quantity: string
  accepted_quantity: string
  rejected_quantity: string
  unit_cost: string | null
  gst_rate: string | null
  accepted_location_id: string | null
  rejected_location_id: string | null
  batch_number: string | null
  manufacturing_date: string | null
  expiry_date: string | null
  serial_numbers: string | null
  rejection_reason: string | null
}

export interface DirectReceiptHeader {
  receipt_date: string
  supplier_id: string | null
  warehouse_id: string
  supplier_document_number: string | null
  supporting_document_ref: string | null
  notes: string | null
  supplier_invoice_number: string | null
  supplier_challan_number: string | null
}

export type ReceiptResult = { receipt_id: string; receipt_number: string; po_status?: string; transaction_numbers: string[]; warnings?: string[]; unlinked?: boolean; duplicate?: boolean }

/** Goods received without a purchase order (always flagged as unlinked). */
export const postDirectGoodsReceipt = (header: DirectReceiptHeader, lines: DirectReceiptLineInput[], requestKey: string) =>
  rpc<ReceiptResult>('goods_receipt_direct_post_refs', { p_header: header, p_lines: lines, p_idempotency_key: requestKey })

/**
 * Reverses a receipt and posts the corrected one in one transaction (both kept in the history).
 * The corrected receipt gets the supplier references in `header`, or keeps those of the original.
 */
export const correctGoodsReceipt = (receiptId: string, reason: string, header: Record<string, unknown>, lines: unknown[], requestKey: string) =>
  rpc<ReceiptResult & { corrects_receipt_number: string; reversal_numbers: string[] }>('goods_receipt_correct_refs', {
    p_receipt_id: receiptId, p_reason: reason, p_header: header, p_lines: lines, p_idempotency_key: requestKey,
  })

/** Delivery date, reference and notes of an order, without a new revision. */
export const updatePoDetails = (poId: string, changes: Partial<Record<'expected_delivery_date' | 'reference_number' | 'delivery_instructions' | 'internal_notes' | 'purchase_conditions', string | null>>, expectedUpdatedAt: string | null) =>
  rpc<{ po_id: string; updated_at: string }>('purchase_order_update_details', { p_po_id: poId, p_changes: changes, p_expected_updated_at: expectedUpdatedAt })

export async function fetchGoodsReceipt(id: string): Promise<{ receipt: GoodsReceiptListRow; lines: GoodsReceiptLineListRow[]; correctedBy: GoodsReceiptListRow | null }> {
  const { data, error } = await db().from('goods_receipt_list_v2').select('*').eq('id', id).single()
  if (error) throw error
  const [lines, next] = await Promise.all([
    db().from('goods_receipt_line_list').select('*').eq('goods_receipt_id', id).order('created_at'),
    db().from('goods_receipt_list_v2').select('*').eq('corrects_receipt_id', id).maybeSingle(),
  ])
  if (lines.error) throw lines.error
  return { receipt: data, lines: lines.data ?? [], correctedBy: next.data ?? null }
}

// ---------------------------------------------------------------------------
// Excel / CSV import (drafts only; see purchase_order_import migration)
// ---------------------------------------------------------------------------
export interface PoImportIssue { row: number | null; message: string }

export interface PoImportPreviewGroup {
  reference: string
  supplier_code: string | null
  supplier_name: string | null
  warehouse_code: string | null
  rows: number[]
  ok: boolean
  errors: PoImportIssue[]
  warnings: PoImportIssue[]
  tax_treatment: string | null
  lines: { row: number; sku: string; unit: string; gst_rate: number | null; gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }[] | null
  totals: { gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; round_off: number; grand: number } | null
}

export interface PoImportPreview {
  groups: PoImportPreviewGroup[]
  previous_imports: { job_id: string; started_at: string; success_rows: number; file_name: string | null }[]
}

/** Server validation + calculation with the real PO functions; nothing is saved. */
export const previewPoImport = (groups: unknown[], fileHash: string | null) =>
  rpc<PoImportPreview>('purchase_order_import_preview', { p_groups: groups, p_file_hash: fileHash })

export interface PoImportResult {
  job_id: string
  created: { reference: string; po_id: string; po_number: string; supplier_code: string; lines: number; grand_total: number; tax_treatment: string }[]
  failed: { reference: string; rows: number[]; errors: PoImportIssue[] }[]
  created_count: number
  failed_count: number
  imported_rows: number
  failed_rows: number
  duplicate?: boolean
}

/** Creates one DRAFT per order (each all-or-nothing). Retrying with the same request id never creates duplicates. */
export const importPurchaseOrders = (
  groups: unknown[],
  file: { file_name: string; file_hash: string | null; total_rows: number },
  rejected: unknown[],
  requestKey: string,
) => rpc<PoImportResult>('purchase_order_import', { p_groups: groups, p_file: file, p_rejected: rejected, p_idempotency_key: requestKey })
