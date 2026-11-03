import type { Tone } from '@/config/status'
import type { PermissionCode } from '@/auth/permissions'
import type { PoLineType, PoStatus, PoTaxTreatment, PurchaseOrderRow, PurchaseType } from '@/types/database-purchasing'
import { isWholeUnit } from '../inventory/whole-units.ts'

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Open',
  SENT: 'Open (sent to supplier)',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Fully received',
  CLOSED: 'Closed (short)',
  CANCELLED: 'Cancelled',
}

export const PO_STATUS_TONES: Record<PoStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  SENT: 'info',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
}

export const PO_STATUSES = Object.keys(PO_STATUS_LABELS) as PoStatus[]

type Cell = string | number | null

/** "Invoice 123 · Challan 45", or null when neither is entered. */
export function refsText(invoice: string | null | undefined, challan: string | null | undefined): string | null {
  const parts = [invoice && `Invoice ${invoice}`, challan && `Challan ${challan}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** Purchase order register for Excel: Alton PO number and the supplier's invoice / challan numbers in separate columns. */
export function poExportRows(rows: {
  po_number: string; revision: number; po_date: string; expected_delivery_date: string | null; status: PoStatus; supplier_code: string; supplier_name: string
  reference_number: string | null; supplier_invoice_number?: string | null; supplier_challan_number?: string | null
  receipt_invoice_numbers?: string | null; receipt_challan_numbers?: string | null; warehouse_code: string | null
  taxable_total: number; grand_total: number; pending_value: number; receipt_count: number
}[]): Cell[][] {
  return [
    ['PO No.', 'Revision', 'PO date', 'Expected delivery', 'Status', 'Supplier code', 'Supplier', 'Reference', 'Supplier invoice no.', 'Supplier challan no.',
      'GRN invoice nos.', 'GRN challan nos.', 'Deliver to', 'Taxable', 'Grand total', 'Pending value', 'Posted GRNs'],
    ...rows.map((o) => [o.po_number, o.revision, o.po_date, o.expected_delivery_date, PO_STATUS_LABELS[o.status], o.supplier_code, o.supplier_name,
      o.reference_number, o.supplier_invoice_number ?? null, o.supplier_challan_number ?? null, o.receipt_invoice_numbers ?? null, o.receipt_challan_numbers ?? null,
      o.warehouse_code, Number(o.taxable_total), Number(o.grand_total), Number(o.pending_value), Number(o.receipt_count)]),
  ]
}

/** Goods received register for Excel: each GRN with its own supplier invoice and challan numbers. */
export function grnExportRows(rows: {
  receipt_number: string; receipt_date: string; receipt_type: string; po_number: string | null; supplier_code: string | null; supplier_name: string | null
  warehouse_code: string | null; supplier_invoice_number?: string | null; supplier_challan_number?: string | null; supplier_document_number: string | null
  supporting_document_ref: string | null; total_received: number; total_accepted: number; total_rejected: number; status: string
}[]): Cell[][] {
  return [
    ['GRN', 'Date', 'Type', 'PO No.', 'Supplier code', 'Supplier', 'Warehouse', 'Supplier invoice no.', 'Supplier challan no.', 'Earlier supplier reference',
      'Supporting document', 'Received', 'Accepted', 'Rejected', 'Status'],
    ...rows.map((r) => [r.receipt_number, r.receipt_date, r.receipt_type === 'DIRECT' ? 'Without PO' : 'Against PO', r.po_number, r.supplier_code, r.supplier_name,
      r.warehouse_code, r.supplier_invoice_number ?? null, r.supplier_challan_number ?? null, r.supplier_document_number, r.supporting_document_ref,
      Number(r.total_received), Number(r.total_accepted), Number(r.total_rejected), r.status === 'POSTED' ? 'Posted' : 'Reversed']),
  ]
}
/** Orders still waiting for goods. */
export const OPEN_PO_STATUSES: PoStatus[] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED']

export const PURCHASE_TYPE_LABELS: Record<PurchaseType, string> = {
  RAW_MATERIAL: 'Raw Material',
  FINISHED_GOODS: 'Finished Goods',
  PACKAGING: 'Packaging',
  MACHINERY: 'Machinery',
  SERVICES: 'Services',
  OTHER: 'Other',
}

export const LINE_TYPE_LABELS: Record<PoLineType, string> = {
  GOODS: 'Goods (stocked)',
  SERVICE: 'Service (not stocked)',
  CHARGE: 'Charge (freight, packing…)',
}

export const TAX_TREATMENT_LABELS: Record<PoTaxTreatment, string> = {
  INTRA_STATE: 'Intra-state: CGST + SGST',
  INTER_STATE: 'Inter-state: IGST',
  NO_GST: 'No GST: supplier has no GSTIN',
  IMPORT: 'Import: overseas supplier (customs duty / IGST on import not calculated)',
  UNRESOLVED: 'Cannot be determined: company GSTIN missing',
}

export const PO_EVENT_LABELS: Record<string, string> = {
  CREATED: 'Created',
  IMPORTED: 'Imported from a spreadsheet',
  UPDATED: 'Draft edited',
  SUBMITTED: 'Submitted for approval',
  WITHDRAWN: 'Withdrawn from approval',
  APPROVED: 'Opened',
  REJECTED: 'Rejected',
  SENT: 'Sent to supplier',
  AMENDED: 'Amended (new revision)',
  CANCELLED: 'Cancelled',
  CLOSED: 'Short-closed',
  RECEIPT_POSTED: 'Goods received',
  RECEIPT_REVERSED: 'Goods receipt reversed',
}

export type PoAction = 'EDIT' | 'OPEN' | 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'SEND' | 'RECEIVE' | 'AMEND' | 'CANCEL' | 'CLOSE' | 'PRINT'

/**
 * Actions to SHOW for an order. UI only: the database checks every one again
 * (permissions, status, segregation of duties) and refuses anything else.
 * V2 single-operator: a user who may approve gets one-step OPEN instead of
 * SUBMIT; SUBMIT (for someone else to approve) is shown only when they can't.
 */
export function availablePoActions(
  po: Pick<PurchaseOrderRow, 'status' | 'created_by' | 'submitted_by' | 'revision'>,
  has: (p: PermissionCode) => boolean,
  userId: string | undefined,
  options: { hasReceipts: boolean; segregationOfDuties?: boolean } = { hasReceipts: false },
): PoAction[] {
  const own = Boolean(userId) && po.created_by === userId
  const canEditDraft = has('purchase_order.update') || (has('purchase_order.create') && own)
  const sod = options.segregationOfDuties ?? false
  const selfApproval = sod && Boolean(userId) && (po.submitted_by === userId || po.created_by === userId)
  const out: PoAction[] = []
  if (po.status === 'DRAFT' && canEditDraft) out.push('EDIT', has('purchase_order.approve') && !(sod && own) ? 'OPEN' : 'SUBMIT')
  if (po.status === 'PENDING_APPROVAL') {
    if (has('purchase_order.approve') && !selfApproval) out.push('APPROVE', 'REJECT')
    if (has('purchase_order.update') || po.submitted_by === userId) out.push('WITHDRAW')
  }
  if (po.status === 'APPROVED' && has('purchase_order.send')) out.push('SEND')
  if (['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status) && has('purchase_receipt.create')) out.push('RECEIVE')
  if (['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status) && has('purchase_order.amend')) out.push('AMEND')
  if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(po.status) && !options.hasReceipts
      && (has('purchase_order.cancel') || (po.status === 'DRAFT' && po.revision === 0 && has('purchase_order.create') && own))) out.push('CANCEL')
  if (po.status === 'PARTIALLY_RECEIVED' && has('purchase_order.cancel')) out.push('CLOSE')
  if (po.status !== 'DRAFT' && po.status !== 'CANCELLED' && has('purchase_order.export')) out.push('PRINT')
  return out
}

/** Editable line in the PO form (strings so partial input is kept). */
export interface PoFormLine {
  key: string
  id: string | null
  line_type: PoLineType
  product_id: string | null
  sku: string | null
  product_name: string | null
  description: string
  unit: string
  hsn_sac: string
  quantity: string
  unit_price: string
  discount_mode: 'PERCENT' | 'AMOUNT'
  discount: string
  gst_rate: string
  received: number
}

const DEC = (max: number) => new RegExp(`^\\d+(\\.\\d{1,${max}})?$`)

/** Field problems in the form; the database validates everything again. */
export function validatePoLines(lines: PoFormLine[]): Map<string, string> {
  const errors = new Map<string, string>()
  lines.forEach((l, i) => {
    const n = i + 1
    const add = (field: string, msg: string) => errors.set(`${l.key}:${field}`, `Line ${n}: ${msg}`)
    if (l.line_type === 'GOODS' && !l.product_id) add('product', 'select a product.')
    if (l.line_type !== 'GOODS' && !l.description.trim()) add('description', 'enter a description.')
    if (l.line_type !== 'GOODS' && !/^[A-Za-z]{1,10}$/.test(l.unit.trim())) add('unit', 'the unit must be 1–10 letters.')
    const wholeOnly = l.line_type === 'GOODS' && isWholeUnit(l.unit)
    if (!(wholeOnly ? /^\d+(\.0+)?$/ : DEC(3)).test(l.quantity.trim()) || Number(l.quantity) <= 0) {
      add('quantity', `enter a quantity greater than zero (${wholeOnly ? `whole ${l.unit.toUpperCase()}` : 'up to 3 decimals'}).`)
    }
    else if (Number(l.quantity) < l.received) add('quantity', `cannot be less than the ${l.received} already received.`)
    if (l.unit_price.trim() && !DEC(4).test(l.unit_price.trim())) add('unit_price', 'the unit price must be a number (up to 4 decimals).')
    if (l.discount.trim()) {
      if (!DEC(2).test(l.discount.trim())) add('discount', 'the discount must be a number (up to 2 decimals).')
      else if (l.discount_mode === 'PERCENT' && Number(l.discount) > 100) add('discount', 'the discount cannot exceed 100%.')
      else if (l.discount_mode === 'AMOUNT' && Number(l.discount) > Number(l.quantity || 0) * Number(l.unit_price || 0) + 0.005) add('discount', 'the discount cannot exceed the line amount.')
    }
    if (l.gst_rate.trim() && (!DEC(2).test(l.gst_rate.trim()) || Number(l.gst_rate) > 100)) add('gst_rate', 'the GST rate must be 0–100.')
    if (l.hsn_sac.trim() && !/^[0-9]{4,8}$/.test(l.hsn_sac.trim())) add('hsn_sac', 'HSN/SAC must be 4–8 digits.')
  })
  return errors
}

/** Payload for public.purchase_order_save. */
export function linesPayload(lines: PoFormLine[]) {
  return lines.map((l) => ({
    id: l.id,
    line_type: l.line_type,
    product_id: l.product_id,
    description: l.description.trim() || null,
    unit: l.line_type === 'GOODS' ? null : l.unit.trim().toUpperCase(),
    hsn_sac: l.hsn_sac.trim() || null,
    quantity: l.quantity.trim(),
    unit_price: l.unit_price.trim() === '' ? null : l.unit_price.trim(),
    discount_percent: l.discount_mode === 'PERCENT' && l.discount.trim() ? l.discount.trim() : null,
    discount_amount: l.discount_mode === 'AMOUNT' && l.discount.trim() ? l.discount.trim() : null,
    gst_rate: l.gst_rate.trim() === '' ? null : l.gst_rate.trim(),
  }))
}
