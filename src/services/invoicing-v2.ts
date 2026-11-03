import { requireSupabase } from '@/lib/supabase'
import type { InvoiceImportGroup, InvoiceImportRow } from '@/features/billing/invoicing-v2-model'
import type { ValidationIssue } from '@/services/billing'
import type { NoteReason, PaymentMethod } from '@/types/database-billing'

/**
 * Stage 6 invoicing (migration 20261107090000_invoicing_v2.sql). Manual and
 * sales-order invoices, proforma, one-step issue, payments, notes, dashboard and
 * Excel import. Every amount is recalculated and validated in the database.
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface InvoiceV2Header {
  customer_id?: string | null
  sales_order_id?: string | null
  invoice_date?: string
  due_date?: string | null
  payment_terms_days?: number | null
  place_of_supply_state_code?: string | null
  supply_category?: string
  special_category_reason?: string | null
  billing_address?: string | null
  shipping_address?: string | null
  customer_gstin?: string | null
  customer_pan?: string | null
  transport_details?: string | null
  vehicle_number?: string | null
  eway_bill_number?: string | null
  notes?: string | null
  internal_notes?: string | null
  pricing_mode?: 'EXCLUSIVE' | 'INCLUSIVE'
  invoice_discount_percent?: string | null
  invoice_discount_amount?: string | null
  is_proforma?: boolean
}

export interface InvoiceV2LineInput {
  product_id: string
  sales_order_line_id?: string | null
  description?: string | null
  hsn_sac?: string | null
  quantity: string
  unit_price?: string | null
  discount_percent?: string | null
  discount_amount?: string | null
  gst_rate?: string | null
}

export interface InvoiceV2SaveResult { invoice_id: string; status: string; is_proforma: boolean; proforma_number: string | null; grand_total: number; issues: ValidationIssue[] }

export const saveInvoiceV2 = (id: string | null, header: InvoiceV2Header, lines: InvoiceV2LineInput[], charges: { freight?: string; packing?: string; other?: string }, key: string | null) =>
  rpc<InvoiceV2SaveResult>('sales_invoice_v2_save', { p_invoice_id: id, p_header: header, p_lines: lines, p_charges: charges, p_idempotency_key: key })

export const issueInvoiceV2 = (id: string, convertProforma: boolean, key: string) =>
  rpc<{
    invoice_id: string; invoice_number: string; financial_year: string; grand_total: number; warnings: string[]
    /** Since 20261115: dispatches made because posting the invoice is the dispatch. */
    dispatched_on_posting?: { sales_order_id: string; dispatched_quantity: number; transaction_numbers: string[] }[]
    partial_invoice?: { partial: boolean; notified?: number }
  }>('sales_invoice_v2_issue',
    { p_invoice_id: id, p_convert_proforma: convertProforma, p_idempotency_key: key })

/**
 * Dispatch coverage of an invoice (migration 20261112090000): an invoice with
 * stock-tracked goods can be posted only when posted dispatches cover every line.
 * Read-only; the same check runs again inside the posting transaction.
 */
export const fetchInvoiceDispatchStatus = (id: string) =>
  rpc<import('@/features/billing/dispatch-status-model').InvoiceDispatchStatus>('invoice_dispatch_status', { p_invoice_id: id })

export interface PartialPreviewLine {
  sales_order_id: string
  sales_order_number: string
  line_id: string
  sku: string
  product_name: string
  unit: string
  ordered: number
  previously_invoiced: number
  this_invoice: number
  remaining: number
}
/** Order quantities an invoice covers (for the partial-invoice warning before posting). */
export const fetchPartialPreview = (id: string) =>
  rpc<{ invoice_id: string; lines: PartialPreviewLine[]; partial: boolean }>('invoice_partial_preview', { p_invoice_id: id })

/** Posted invoices whose goods are not covered by valid dispatches (e.g. posted before the rule). */
export const fetchInvoiceDispatchExceptions = () =>
  rpc<{ checked_at: string; rows: import('@/features/billing/dispatch-status-model').DispatchExceptionRow[] }>('invoice_dispatch_exceptions', {})

export interface SoInvoiceLine {
  sales_order_line_id: string
  line_no: number
  product_id: string
  sku: string
  product_name: string
  description: string
  unit: string
  hsn_code: string | null
  ordered: number
  dispatched: number
  invoiced: number
  pending: number
  unit_price: number | null
  discount_percent: number | null
  gst_rate: number | null
}

export interface SoInvoiceLines {
  sales_order_id: string
  sales_order_number: string
  customer_id: string | null
  customer_name: string
  customer_reference: string | null
  payment_terms: string | null
  billing_address: string | null
  shipping_address: string | null
  freight_amount: number | null
  other_charges_amount: number | null
  lines: SoInvoiceLine[]
}

export const fetchSoInvoiceLines = (soId: string) => rpc<SoInvoiceLines>('sales_order_invoice_lines', { p_so_id: soId })

export interface InvoicePaymentInput {
  receipt_date: string
  amount: string
  payment_method: PaymentMethod
  transaction_reference?: string | null
  bank_reference?: string | null
  notes?: string | null
  confirm_duplicate?: boolean
}

export const recordInvoicePayment = (invoiceId: string, payment: InvoicePaymentInput, key: string) =>
  rpc<{ payment_id: string; receipt_number: string; allocated: number; advance: number; balance_due: number; warnings: string[] }>('invoice_v2_record_payment',
    { p_invoice_id: invoiceId, p_payment: payment, p_idempotency_key: key })

export const applyAdvance = (invoiceId: string, paymentId: string, amount: string | null, key: string) =>
  rpc<{ applied: number; balance_due: number; receipt_number: string; unallocated: number }>('invoice_v2_apply_advance',
    { p_invoice_id: invoiceId, p_payment_id: paymentId, p_amount: amount ? Number(amount) : null, p_idempotency_key: key })

export const issueNoteV2 = (
  invoiceId: string, type: 'CREDIT' | 'DEBIT',
  header: { note_date?: string; reason_code: NoteReason; reason: string; supporting_reference?: string | null },
  lines: { invoice_line_id: string; quantity?: string; taxable_amount?: string }[], key: string,
) => rpc<{ note_id: string; note_number: string; total: number; balance_due: number }>('adjustment_note_v2_issue',
  { p_invoice_id: invoiceId, p_type: type, p_header: header, p_lines: lines, p_idempotency_key: key })

export interface InvoiceDashboard {
  from: string
  to: string
  today: string
  currency: string
  total_invoices: number
  created_today: number
  this_month: number
  total_value: number
  taxable_value: number
  gst_collected: number
  amount_received: number
  outstanding: number
  overdue_amount: number
  partially_paid: number
  fully_paid: number
  drafts: number
  proforma: number
  cancelled: number
  recent: { id: string; invoice_number: string | null; invoice_date: string; customer_name: string; grand_total: number; balance_due: number | null; status: string; payment_status: string | null; created_at: string }[]
  overdue: { id: string; invoice_number: string; customer_name: string; due_date: string; balance_due: number; days_overdue: number }[]
  monthly: { month: string; invoiced: number; received: number; gst: number }[]
  gst_summary: { gst_rate: number | null; taxable: number; cgst: number; sgst: number; igst: number; tax: number; lines: number }[]
  hsn_summary: { hsn_sac: string; gst_rate: number | null; taxable: number; tax: number }[]
}

export const fetchInvoiceDashboard = (from: string, to: string, customerId: string | null, invoiceStatus: string | null, paymentStatus: string | null) =>
  rpc<InvoiceDashboard>('invoice_dashboard', { p_from: from, p_to: to, p_customer_id: customerId, p_invoice_status: invoiceStatus, p_payment_status: paymentStatus })

export interface InvoiceImportPreview {
  invoices: InvoiceImportGroup[]
  rows: number
  valid: number
  warnings: number
  errors: number
  missing_customers: { name: string | null; gstin: string | null }[]
  missing_products: { sku: string; name: string | null }[]
}

export const previewInvoiceImport = (rows: InvoiceImportRow[]) => rpc<InvoiceImportPreview>('invoice_import_preview', { p_rows: rows })

export interface InvoiceImportResult {
  job_id: string
  created: { first_row: number; invoice_id: string; invoice_number: string; grand_total: number; rows: number[] }[]
  failed: { first_row: number; invoice_number: string | null; messages: string[]; rows: number[] }[]
  created_count: number
  failed_count: number
}

export const runInvoiceImport = (rows: InvoiceImportRow[], file: { file_name: string }, key: string) =>
  rpc<InvoiceImportResult>('invoice_import', { p_rows: rows, p_file: file, p_idempotency_key: key })

/** Receipts of a customer that still have money not allocated to invoices (advances). */
export async function fetchAdvances(customerId: string): Promise<{ id: string; receipt_number: string; receipt_date: string; amount_received: number; unallocated_amount: number }[]> {
  const { data, error } = await requireSupabase().from('customer_payment_list').select('*').eq('customer_id', customerId).eq('status', 'RECORDED').gt('unallocated_amount', 0)
    .order('receipt_date')
  if (error) throw error
  return (data ?? []) as never
}
