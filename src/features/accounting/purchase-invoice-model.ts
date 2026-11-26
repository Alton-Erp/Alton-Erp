// Supplier (purchase) invoices — Alton Accounts Phase 3 (migration 20261231090300).
// Types, the live GST / totals preview (the same rounding as the database, which recalculates everything on save),
// form validation and the payload sent to purchase_invoice_save. The database is authoritative for every figure.

import type { PermissionCode } from '@/auth/permissions'
import { newAllocation, toPaise, type AllocationForm, type Amount, type CostCentre, type CostCentrePolicy, type Tone } from './accounting-model.ts'

export type PiStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REVERSED' | 'CANCELLED'
export type PiType = 'GOODS' | 'SERVICE' | 'EXPENSE' | 'FREIGHT' | 'OTHER'
export type SupplyCategory = 'TAXABLE' | 'EXEMPT' | 'NIL_RATED' | 'NON_GST'
export type TaxTreatment = 'INTRA_STATE' | 'INTER_STATE'
export type VarianceStatus = 'NONE' | 'WITHIN_TOLERANCE' | 'EXCEPTION' | 'APPROVED'
export type GstStatus = 'NOT_APPLICABLE' | 'PENDING_VERIFICATION' | 'ELIGIBLE' | 'INELIGIBLE'
export type PiReportKey = 'PURCHASE_REGISTER' | 'SUPPLIER_INVOICE_REGISTER' | 'OUTSTANDING' | 'AGEING' | 'GRN_RECONCILIATION' | 'GST_PENDING' | 'ITC_SUMMARY'
  | 'PRICE_VARIANCE' | 'COST_CENTRE_EXPENSE'

export interface PiIssue { code: string; message: string; blocking: boolean; line_no?: number; amount?: Amount }

export interface PiLine {
  id: string
  line_no: number
  line_kind: 'GRN' | 'DIRECT'
  goods_receipt_id: string | null
  goods_receipt_line_id: string | null
  account_id: string | null
  account_code: string | null
  account_name: string | null
  description: string | null
  quantity: Amount
  unit_price: Amount
  discount: Amount
  taxable_value: Amount
  gst_rate: Amount
  cgst: Amount
  sgst: Amount
  igst: Amount
  cess: Amount
  matched_net: Amount | null
  matched_gst: Amount | null
  matched_payable: Amount | null
  grn_unit_cost: Amount | null
  grn_gst_rate: Amount | null
  receipt_number: string | null
  receipt_date: string | null
  product_name: string | null
  grn_accepted: Amount | null
  grn_payable: Amount | null
  grn_net: Amount | null
  grn_unit_cost_now: Amount | null
  grn_rate: Amount | null
  grn_invoiced_elsewhere: Amount | null
  allocations: { cost_centre_id: string; cost_centre_code: string; cost_centre_name: string; amount: Amount }[]
}

export interface PiPayment {
  id: string; payment_id: string; payment_number: string; payment_date: string; payment_status: string; amount: Amount; status: 'ACTIVE' | 'REVERSED'
  reversal_reason: string | null; created_at: string
}

export interface PurchaseInvoice {
  id: string
  invoice_number: string
  supplier_id: string
  supplier_code: string
  supplier_name: string
  party_id: string
  party_code: string
  supplier_gstin: string | null
  supplier_invoice_number: string
  supplier_invoice_date: string
  recorded_date: string
  due_date: string | null
  purchase_order_id: string | null
  purchase_order_number: string | null
  invoice_type: PiType
  supply_category: SupplyCategory
  place_of_supply_state_code: string | null
  tax_treatment: TaxTreatment
  reverse_charge: boolean
  currency: string
  subtotal: Amount
  discount_total: Amount
  taxable_value: Amount
  cgst_total: Amount
  sgst_total: Amount
  igst_total: Amount
  cess_total: Amount
  round_off: Amount
  grand_total: Amount
  supplier_stated_total: Amount | null
  narration: string | null
  status: PiStatus
  variance_status: VarianceStatus
  variance_note: string | null
  gst_status: GstStatus
  gst_verification: { status: string; reason: string; checks: Record<string, boolean> } | null
  gst_verified_at: string | null
  voucher_id: string | null
  voucher_number: string | null
  gst_voucher_id: string | null
  gst_voucher_number: string | null
  reconciliation: {
    lines: { line_no: number; receipt: string; quantity: Amount; receipt_payable_share: Amount; invoice_amount: Amount; creditors_adjustment: Amount }[]
    receipt_share_total: Amount; creditors_posted_by_invoice: Amount; invoice_total: Amount; reconciled: boolean
  } | null
  row_version: number
  created_at: string
  created_by_name: string | null
  approved_at: string | null
  approved_by_name: string | null
  posted_at: string | null
  posted_by_name: string | null
  reversed_at: string | null
  reversal_reason: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  outstanding: Amount | null
  paid: Amount | null
  lines: PiLine[]
  payments: PiPayment[]
  history: { action: string; note: string | null; details: Record<string, unknown>; at: string; by: string | null }[]
  issues?: PiIssue[]
}

export interface PiListRow {
  id: string; invoice_number: string; supplier_id: string; supplier_name: string; supplier_code: string; supplier_invoice_number: string; supplier_invoice_date: string
  recorded_date: string; due_date: string | null; invoice_type: PiType; status: PiStatus; variance_status: VarianceStatus; gst_status: GstStatus; taxable_value: Amount
  tax_total: Amount; grand_total: Amount; outstanding: Amount | null; reverse_charge: boolean; voucher_number: string | null; has_grn: boolean; created_by_name: string | null
}

export interface MatchingCandidate {
  line_id: string; receipt_id: string; receipt_number: string; receipt_date: string; receipt_type: string; purchase_order_id: string | null; po_number: string | null
  description: string | null; unit: string | null; ordered_quantity: Amount | null; received_quantity: Amount; accepted_quantity: Amount; invoiced_quantity: Amount
  posted_invoiced_quantity: Amount; remaining_quantity: Amount; unit_cost: Amount; gst_rate: Amount; payable: Amount; net: Amount; gst: Amount; in_books: boolean
}

export interface SupplierPaymentOption { id: string; payment_number: string; payment_date: string; amount: Amount; payment_method: string; reference: string | null; unallocated: Amount }

export interface PiLookupSupplier { id: string; supplier_code: string; name: string; gstin: string | null; state_code: string | null; payment_terms: string }
export interface PiLookupAccount { id: string; account_code: string; account_name: string; classification: string; cost_centre_policy: CostCentrePolicy }
export interface PiLookups {
  initialized: boolean; today: string; books_start_date: string | null; pi_price_tolerance_percent: Amount | null; pi_amount_tolerance: Amount | null
  company_state_code: string | null; suppliers: PiLookupSupplier[]; accounts: PiLookupAccount[]; cost_centres: CostCentre[]
}

// Reports: rows are plain records (columns are defined by the reports screen).
export type PiReportRow = Record<string, string | number | boolean | null>
export interface PiReport { report: PiReportKey; rows: PiReportRow[]; as_of?: string; ledger_pending_balance?: Amount; unallocated?: Amount; invoices?: Record<string, number> | null }

// ---- labels ------------------------------------------------------------------------------------------------------
export const PI_TYPES: PiType[] = ['GOODS', 'SERVICE', 'EXPENSE', 'FREIGHT', 'OTHER']
export const PI_TYPE_LABELS: Record<PiType, string> = { GOODS: 'Goods', SERVICE: 'Service', EXPENSE: 'Expense', FREIGHT: 'Freight', OTHER: 'Other' }
export const SUPPLY_CATEGORIES: SupplyCategory[] = ['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST']
export const SUPPLY_CATEGORY_LABELS: Record<SupplyCategory, string> = { TAXABLE: 'Taxable', EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated', NON_GST: 'Non-GST' }
/** The GST rates the database accepts (purchase_invoice_save). */
export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28] as const
export const PI_STATUS_META: Record<PiStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, SUBMITTED: { label: 'Submitted', tone: 'info' }, APPROVED: { label: 'Approved', tone: 'info' },
  POSTED: { label: 'Posted', tone: 'success' }, REVERSED: { label: 'Reversed', tone: 'warning' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}
export const GST_STATUS_META: Record<GstStatus, { label: string; tone: Tone }> = {
  NOT_APPLICABLE: { label: 'No GST', tone: 'neutral' }, PENDING_VERIFICATION: { label: 'GST pending verification', tone: 'warning' },
  ELIGIBLE: { label: 'ITC eligible', tone: 'success' }, INELIGIBLE: { label: 'ITC ineligible', tone: 'danger' },
}
export const VARIANCE_STATUS_META: Record<VarianceStatus, { label: string; tone: Tone }> = {
  NONE: { label: 'Not matched', tone: 'neutral' }, WITHIN_TOLERANCE: { label: 'Matched', tone: 'success' },
  EXCEPTION: { label: 'Variance — needs approval', tone: 'danger' }, APPROVED: { label: 'Variance approved', tone: 'warning' },
}
export const PI_REPORTS: { key: PiReportKey; label: string; accounting: boolean; description: string }[] = [
  { key: 'PURCHASE_REGISTER', label: 'Purchase register', accounting: false, description: 'Posted and reversed supplier invoices by recording date, with GST split.' },
  { key: 'SUPPLIER_INVOICE_REGISTER', label: 'Supplier invoice register', accounting: false, description: 'Every supplier invoice in any status, including drafts and cancelled ones.' },
  { key: 'GRN_RECONCILIATION', label: 'GRN vs invoice', accounting: false, description: 'Receipt lines with invoiced and uninvoiced quantities, the receipt payable share and the difference posted.' },
  { key: 'OUTSTANDING', label: 'Supplier outstanding', accounting: false, description: 'Posted invoices not fully paid, by due date (payments allocated to invoices).' },
  { key: 'AGEING', label: 'AP ageing', accounting: false, description: 'Outstanding invoices by days past due per supplier, with the supplier\'s Creditors ledger balance beside it.' },
  { key: 'GST_PENDING', label: 'GST pending verification', accounting: false, description: 'Posted invoices whose input GST has not been verified yet, with the ledger balance of GST pending.' },
  { key: 'ITC_SUMMARY', label: 'Input tax credit summary', accounting: true, description: 'Balances of the GST pending, input CGST / SGST / IGST / cess, ineligible and RCM ledgers from posted vouchers.' },
  { key: 'PRICE_VARIANCE', label: 'Price variance', accounting: false, description: 'Matched lines whose invoice value differs from the receipt value.' },
  { key: 'COST_CENTRE_EXPENSE', label: 'Cost-centre purchase expense', accounting: true, description: 'Supplier-invoice expense per cost centre and ledger from posted vouchers; un-split expense shown separately.' },
]

// ---- arithmetic (paise / exact) -----------------------------------------------------------------------------------
/** Half away from zero, as PostgreSQL rounds numeric. */
const roundHalf = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x))
const num = (v: string | number | null | undefined) => Number(String(v ?? '').trim() || 0)
/** round(quantity × price, 2) in paise; quantity to 3 decimals, price to 2. */
export function lineGrossPaise(quantity: string | number, unitPrice: string | number): number {
  const q = Math.round(num(quantity) * 1000)
  const p = Math.round(num(unitPrice) * 100)
  return roundHalf((q * p) / 1000)
}
export function effectiveTreatment(form: Pick<PiForm, 'tax_treatment' | 'place_of_supply_state_code'>, companyState: string | null): TaxTreatment {
  if (form.tax_treatment) return form.tax_treatment
  const pos = form.place_of_supply_state_code.trim()
  return companyState && pos && companyState !== pos ? 'INTER_STATE' : 'INTRA_STATE'
}
/** Line taxes exactly as private.pi_recalculate: CGST = SGST = round(taxable × rate / 200, 2) intra-state, IGST = round(taxable × rate / 100, 2). */
export function lineTaxesPaise(taxablePaise: number, rate: number, category: SupplyCategory, treatment: TaxTreatment, cessPaise = 0) {
  if (category !== 'TAXABLE') return { cgst: 0, sgst: 0, igst: 0, cess: 0 }
  const bp = Math.round(rate * 100)
  if (treatment === 'INTRA_STATE') { const half = roundHalf((taxablePaise * bp) / 20000); return { cgst: half, sgst: half, igst: 0, cess: cessPaise } }
  return { cgst: 0, sgst: 0, igst: roundHalf((taxablePaise * bp) / 10000), cess: cessPaise }
}

// ---- form --------------------------------------------------------------------------------------------------------
export interface PiGrnInfo { receipt_number: string; receipt_date: string; description: string | null; remaining: number; unit_cost: number; gst_rate: number; in_books: boolean }
export interface PiLineForm {
  key: string; kind: 'GRN' | 'DIRECT'; goods_receipt_line_id: string; account_id: string; description: string; quantity: string; unit_price: string
  discount: string; gst_rate: string; cess: string; allocations: AllocationForm[]; grn?: PiGrnInfo
}
export interface PiForm {
  supplier_id: string; supplier_gstin: string; supplier_invoice_number: string; supplier_invoice_date: string; recorded_date: string; due_date: string
  purchase_order_id: string; invoice_type: PiType; supply_category: SupplyCategory; place_of_supply_state_code: string; tax_treatment: TaxTreatment | ''
  reverse_charge: boolean; round_off: string; supplier_stated_total: string; narration: string; lines: PiLineForm[]
}
let piKey = 0
export const newPiLine = (kind: 'GRN' | 'DIRECT' = 'DIRECT', patch: Partial<PiLineForm> = {}): PiLineForm => ({
  key: `pl${++piKey}`, kind, goods_receipt_line_id: '', account_id: '', description: '', quantity: '1', unit_price: '', discount: '', gst_rate: '18', cess: '',
  allocations: [], ...patch,
})
export const emptyPiForm = (today: string): PiForm => ({
  supplier_id: '', supplier_gstin: '', supplier_invoice_number: '', supplier_invoice_date: today, recorded_date: today, due_date: '', purchase_order_id: '',
  invoice_type: 'GOODS', supply_category: 'TAXABLE', place_of_supply_state_code: '', tax_treatment: '', reverse_charge: false, round_off: '', supplier_stated_total: '',
  narration: '', lines: [],
})
const s = (v: Amount | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)))
/** Lines from matching candidates (quantity = the remaining quantity, price and rate = the receipt's). */
export const linesFromCandidates = (cands: MatchingCandidate[]): PiLineForm[] => cands.map((c) => newPiLine('GRN', {
  goods_receipt_line_id: c.line_id, description: c.description ?? '', quantity: s(c.remaining_quantity), unit_price: s(c.unit_cost), gst_rate: s(c.gst_rate),
  grn: { receipt_number: c.receipt_number, receipt_date: c.receipt_date, description: c.description, remaining: Number(c.remaining_quantity), unit_cost: Number(c.unit_cost),
    gst_rate: Number(c.gst_rate), in_books: c.in_books },
}))
export function piFormFromInvoice(x: PurchaseInvoice): PiForm {
  return {
    supplier_id: x.supplier_id, supplier_gstin: x.supplier_gstin ?? '', supplier_invoice_number: x.supplier_invoice_number, supplier_invoice_date: x.supplier_invoice_date,
    recorded_date: x.recorded_date, due_date: x.due_date ?? '', purchase_order_id: x.purchase_order_id ?? '', invoice_type: x.invoice_type, supply_category: x.supply_category,
    place_of_supply_state_code: x.place_of_supply_state_code ?? '', tax_treatment: x.tax_treatment, reverse_charge: x.reverse_charge,
    round_off: Number(x.round_off) ? Number(x.round_off).toFixed(2) : '', supplier_stated_total: x.supplier_stated_total === null ? '' : Number(x.supplier_stated_total).toFixed(2),
    narration: x.narration ?? '',
    lines: x.lines.map((l) => newPiLine(l.line_kind, {
      goods_receipt_line_id: l.goods_receipt_line_id ?? '', account_id: l.account_id ?? '', description: l.description ?? '', quantity: s(l.quantity), unit_price: s(l.unit_price),
      discount: Number(l.discount) ? Number(l.discount).toFixed(2) : '', gst_rate: s(l.gst_rate), cess: Number(l.cess) ? Number(l.cess).toFixed(2) : '',
      allocations: l.allocations.map((a) => ({ ...newAllocation(), cost_centre_id: a.cost_centre_id, amount: Number(a.amount).toFixed(2) })),
      grn: l.line_kind === 'GRN' ? { receipt_number: l.receipt_number ?? '', receipt_date: l.receipt_date ?? '', description: l.product_name, unit_cost: Number(l.grn_unit_cost_now ?? 0),
        gst_rate: Number(l.grn_rate ?? 0), remaining: Number(l.grn_accepted ?? 0) - Number(l.grn_invoiced_elsewhere ?? 0), in_books: true } : undefined,
    })),
  }
}

export interface PiPreviewLine { key: string; gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number }
export interface PiPreview {
  treatment: TaxTreatment; lines: PiPreviewLine[]
  /** Paise. */
  totals: { gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; tax: number; roundOff: number; grandTotal: number }
}
/** Live preview in paise (the database recalculates on save and its figures are the ones posted). */
export function previewPi(form: PiForm, companyState: string | null): PiPreview {
  const treatment = effectiveTreatment(form, companyState)
  const lines = form.lines.map((l) => {
    const gross = lineGrossPaise(l.quantity, l.unit_price)
    const discount = toPaise(l.discount)
    const taxable = gross - discount
    const t = lineTaxesPaise(Math.max(taxable, 0), num(l.gst_rate), form.supply_category, treatment, toPaise(l.cess))
    return { key: l.key, gross, discount, taxable, ...t, total: taxable + t.cgst + t.sgst + t.igst + t.cess }
  })
  const sum = (k: keyof Omit<PiPreviewLine, 'key'>) => lines.reduce((t, l) => t + l[k], 0)
  const tax = sum('cgst') + sum('sgst') + sum('igst') + sum('cess')
  const roundOff = toPaise(form.round_off)
  return {
    treatment, lines,
    totals: { gross: sum('gross'), discount: sum('discount'), taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), cess: sum('cess'), tax, roundOff,
      grandTotal: sum('taxable') + roundOff + (form.reverse_charge ? 0 : tax) },
  }
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const isValidGstin = (v: string) => GSTIN_PATTERN.test(v.trim().toUpperCase())
const amount2 = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim())

export interface PiValidation { errors: string[]; lineErrors: Record<string, string> }
/**
 * Browser-side checks before saving (forSubmit: also what submitting needs). The database repeats every check, including the
 * receipt quantities, duplicate supplier invoice numbers and the receipt-posting state.
 */
export function validatePiForm(form: PiForm, preview: PiPreview, accounts: Pick<PiLookupAccount, 'id' | 'cost_centre_policy'>[], forSubmit: boolean): PiValidation {
  const errors: string[] = []
  const lineErrors: Record<string, string> = {}
  if (!form.supplier_id) errors.push('Select the supplier.')
  if (!form.supplier_invoice_number.trim()) errors.push('Enter the supplier\'s invoice number.')
  if (!form.supplier_invoice_date) errors.push('Enter the supplier invoice date.')
  if (form.recorded_date && form.supplier_invoice_date && form.recorded_date < form.supplier_invoice_date) errors.push('The recording date cannot be before the supplier invoice date.')
  if (form.due_date && form.supplier_invoice_date && form.due_date < form.supplier_invoice_date) errors.push('The due date cannot be before the supplier invoice date.')
  if (form.supplier_gstin.trim() && !isValidGstin(form.supplier_gstin)) errors.push('The supplier GSTIN is not a valid GSTIN.')
  if (form.place_of_supply_state_code.trim() && !/^[0-9]{2}$/.test(form.place_of_supply_state_code.trim())) errors.push('The place of supply must be a 2-digit state code.')
  if (form.round_off.trim() && (!/^-?\d+(\.\d{1,2})?$/.test(form.round_off.trim()) || Math.abs(Number(form.round_off)) > 1)) errors.push('The round-off must be between -1.00 and 1.00.')
  if (form.supplier_stated_total.trim() && !amount2(form.supplier_stated_total)) errors.push('The supplier invoice total must be an amount with at most 2 decimals.')
  for (const l of form.lines) {
    const e: string[] = []
    if (l.kind === 'GRN' && !l.goods_receipt_line_id) e.push('select a goods receipt line')
    if (l.kind === 'DIRECT' && !l.account_id) e.push('select a ledger account')
    if (!/^\d+(\.\d{1,3})?$/.test(l.quantity.trim()) || Number(l.quantity) <= 0) e.push('quantity must be more than 0 (3 decimals at most)')
    if (!amount2(l.unit_price || '0')) e.push('unit price: an amount with at most 2 decimals')
    if (l.discount.trim() && !amount2(l.discount)) e.push('discount: an amount with at most 2 decimals')
    if (l.cess.trim() && !amount2(l.cess)) e.push('cess: an amount with at most 2 decimals')
    if (!(GST_RATES as readonly number[]).includes(num(l.gst_rate))) e.push(`${l.gst_rate || 'blank'}% is not a GST rate`)
    if (form.supply_category !== 'TAXABLE' && (num(l.gst_rate) !== 0 || toPaise(l.cess) !== 0)) e.push(`${SUPPLY_CATEGORY_LABELS[form.supply_category]} supplies carry no GST: set the rate and cess to 0`)
    const pl = preview.lines.find((x) => x.key === l.key)
    if (pl && pl.taxable < 0) e.push('the discount is larger than the line value')
    if (l.kind === 'GRN' && l.grn && Number(l.quantity) > l.grn.remaining) e.push(`only ${l.grn.remaining} of ${l.grn.receipt_number} remains uninvoiced`)
    if (l.kind === 'DIRECT' && l.allocations.length > 0 && pl && l.allocations.reduce((t, a) => t + toPaise(a.amount), 0) !== pl.taxable) e.push('the cost-centre split must equal the taxable value')
    const policy = accounts.find((a) => a.id === l.account_id)?.cost_centre_policy
    if (forSubmit && l.kind === 'DIRECT' && policy === 'REQUIRED' && l.allocations.length === 0 && pl && pl.taxable > 0) e.push('this account needs a cost-centre split')
    if (l.kind === 'DIRECT' && policy === 'NOT_APPLICABLE' && l.allocations.length > 0) e.push('this account does not take cost centres')
    if (e.length) lineErrors[l.key] = e.join('; ')
  }
  const goodsLines = form.lines.filter((l) => l.kind === 'GRN')
  if (form.reverse_charge && goodsLines.length) errors.push('Reverse-charge invoices cannot be matched to goods receipts here; enter them as direct lines.')
  if (forSubmit) {
    if (!form.lines.length) errors.push('Add at least one line.')
    if (!form.supplier_stated_total.trim()) errors.push('Enter the total printed on the supplier invoice.')
    else if (toPaise(form.supplier_stated_total) !== preview.totals.grandTotal) {
      errors.push(`The supplier's total (${(toPaise(form.supplier_stated_total) / 100).toFixed(2)}) differs from the calculated total (${(preview.totals.grandTotal / 100).toFixed(2)}).`)
    }
    if (preview.totals.tax > 0 && !form.place_of_supply_state_code.trim()) errors.push('The place of supply is required when GST is charged.')
  }
  return { errors, lineErrors }
}

/** The payload of purchase_invoice_save (amounts as strings; empty optional fields as null). */
export function piPayload(form: PiForm): Record<string, unknown> {
  const opt = (v: string) => (v.trim() ? v.trim() : null)
  return {
    supplier_id: form.supplier_id, supplier_gstin: opt(form.supplier_gstin.toUpperCase()), supplier_invoice_number: form.supplier_invoice_number.trim(),
    supplier_invoice_date: form.supplier_invoice_date, recorded_date: opt(form.recorded_date), due_date: opt(form.due_date), purchase_order_id: opt(form.purchase_order_id),
    invoice_type: form.invoice_type, supply_category: form.supply_category, place_of_supply_state_code: opt(form.place_of_supply_state_code),
    tax_treatment: form.tax_treatment || null, reverse_charge: form.reverse_charge, round_off: opt(form.round_off) ?? '0', supplier_stated_total: opt(form.supplier_stated_total),
    narration: opt(form.narration),
    lines: form.lines.map((l) => ({
      kind: l.kind, ...(l.kind === 'GRN' ? { goods_receipt_line_id: l.goods_receipt_line_id } : { account_id: l.account_id }),
      description: opt(l.description), quantity: l.quantity.trim(), unit_price: l.unit_price.trim() || '0', discount: l.discount.trim() || '0', gst_rate: l.gst_rate.trim() || '0',
      cess: l.cess.trim() || '0',
      ...(l.kind === 'DIRECT' ? { allocations: l.allocations.filter((a) => a.cost_centre_id).map((a) => ({ cost_centre_id: a.cost_centre_id, amount: a.amount.trim() })) } : {}),
    })),
  }
}

/** Which actions the invoice offers in its current state for the given permissions (the database checks again). */
export function piActions(x: Pick<PurchaseInvoice, 'status' | 'gst_status' | 'variance_status'>, has: (code: PermissionCode) => boolean) {
  return {
    edit: x.status === 'DRAFT' && has('purchase_invoices.create'),
    submit: x.status === 'DRAFT' && has('purchase_invoices.create'),
    approve: x.status === 'SUBMITTED' && has('purchase_invoices.approve'),
    returnToDraft: (x.status === 'SUBMITTED' || x.status === 'APPROVED') && (has('purchase_invoices.create') || has('purchase_invoices.approve')),
    cancel: ['DRAFT', 'SUBMITTED', 'APPROVED'].includes(x.status) && has('purchase_invoices.create'),
    post: x.status === 'APPROVED' && has('purchase_invoices.post'),
    verifyGst: x.status === 'POSTED' && x.gst_status === 'PENDING_VERIFICATION' && has('purchase_invoices.verify_gst'),
    reverse: x.status === 'POSTED' && has('purchase_invoices.reverse'),
    allocate: x.status === 'POSTED' && has('supplier_payment.manage'),
    needsVarianceAcceptance: x.status === 'SUBMITTED' && x.variance_status === 'EXCEPTION',
  }
}
