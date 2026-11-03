import { requireSupabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import type {
  AdjustmentNoteLineRow,
  AdjustmentNoteListRow,
  BillingEventRow,
  CustomerPaymentListRow,
  InvoiceDisplayStatus,
  InvoiceSettingsRow,
  InvoiceableDispatchRow,
  NoteReason,
  NoteStatus,
  NoteType,
  PaymentAllocationListRow,
  PaymentMethod,
  PaymentStatus,
  SalesInvoiceLineRow,
  SalesInvoiceListRow,
  SupplyCategory,
} from '@/types/database-billing'

/**
 * Billing data access. Every amount is calculated and validated in the
 * database (SECURITY DEFINER functions with row locks and idempotency keys);
 * the browser only displays results and never computes authoritative money.
 */

const db = () => requireSupabase()

async function rpc<T = Json>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Settings and reference data
// ---------------------------------------------------------------------------
export type BillingSettings = InvoiceSettingsRow & {
  company: { legal_name: string; legal_address: string | null; state: string | null; gstin: string | null; state_code: string | null; state_name: string | null; currency_code: string }
  current_financial_year: string
  example_invoice_number: string
  example_credit_note_number: string
  example_receipt_number: string
}

export const fetchBillingSettings = () => rpc<BillingSettings>('billing_settings_get', {})
export const updateBillingSettings = (changes: Partial<InvoiceSettingsRow>) => rpc<BillingSettings>('billing_settings_update', { p_changes: changes })
export const fetchGstStates = () => rpc<{ code: string; name: string }[]>('gst_state_codes', {})

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export interface InvoiceFilters {
  search: string
  statuses: InvoiceDisplayStatus[] | null
  paymentStatus: PaymentStatus | null
  customerId: string | null
  from: string | null
  to: string | null
  issuedOnly?: boolean
  invoiceType?: 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | null
}

export async function fetchInvoicesPage(f: InvoiceFilters, page: number, pageSize: number): Promise<{ rows: SalesInvoiceListRow[]; total: number }> {
  let query = db().from('sales_invoice_list').select('*', { count: 'exact' }).neq('status', 'DISCARDED')
  if (f.issuedOnly) query = query.in('status', ['ISSUED', 'CANCELLED'])
  if (f.statuses?.length) query = query.in('display_status', f.statuses)
  if (f.paymentStatus) query = query.eq('payment_status', f.paymentStatus)
  if (f.customerId) query = query.eq('customer_id', f.customerId)
  if (f.invoiceType) query = query.eq('invoice_type', f.invoiceType)
  if (f.from) query = query.gte('invoice_date', f.from)
  if (f.to) query = query.lte('invoice_date', f.to)
  const term = f.search.trim().replace(/[%,()*]/g, ' ').trim()
  if (term) query = query.or(`invoice_number.ilike.%${term}%,customer_legal_name.ilike.%${term}%,order_references.ilike.%${term}%,dispatch_references.ilike.%${term}%`)
  const from = page * pageSize
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: (data ?? []) as SalesInvoiceListRow[], total: count ?? 0 }
}

export async function fetchInvoice(id: string): Promise<SalesInvoiceListRow> {
  const { data, error } = await db().from('sales_invoice_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as SalesInvoiceListRow
}

export async function fetchInvoiceLines(invoiceId: string): Promise<SalesInvoiceLineRow[]> {
  const { data, error } = await db().from('sales_invoice_lines').select('*').eq('invoice_id', invoiceId).order('line_no')
  if (error) throw error
  return data ?? []
}

/** Open (balance > 0) issued invoices of a customer, oldest due first. */
export async function fetchOpenInvoices(customerId: string): Promise<SalesInvoiceListRow[]> {
  const { data, error } = await db().from('sales_invoice_list').select('*').eq('customer_id', customerId).eq('status', 'ISSUED').gt('balance_due', 0)
    .order('due_date').order('invoice_number').limit(500)
  if (error) throw error
  return (data ?? []) as SalesInvoiceListRow[]
}

export async function fetchIssuedInvoices(customerId: string | null): Promise<SalesInvoiceListRow[]> {
  let query = db().from('sales_invoice_list').select('*').eq('status', 'ISSUED').order('invoice_date', { ascending: false }).limit(1000)
  if (customerId) query = query.eq('customer_id', customerId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as SalesInvoiceListRow[]
}

export async function fetchInvoiceableDispatches(customerId: string | null): Promise<InvoiceableDispatchRow[]> {
  let query = db().from('invoiceable_dispatch_list').select('*').gt('quantity_invoiceable', 0).order('actual_dispatch_at', { ascending: false }).limit(2000)
  if (customerId) query = query.eq('customer_id', customerId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as InvoiceableDispatchRow[]
}

export async function fetchBillingEvents(filter: { invoiceId?: string; entityId?: string }): Promise<BillingEventRow[]> {
  let query = db().from('billing_events').select('*').order('created_at', { ascending: true }).limit(500)
  if (filter.invoiceId) query = query.eq('invoice_id', filter.invoiceId)
  if (filter.entityId) query = query.eq('entity_id', filter.entityId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export interface InvoiceHeaderInput {
  invoice_date?: string
  payment_terms_days?: number
  place_of_supply_state_code?: string | null
  supply_category?: SupplyCategory
  special_category_reason?: string | null
  notes?: string | null
  internal_notes?: string | null
}

export type ValidationIssue = { severity: 'BLOCK' | 'REVIEW'; code?: string; line_no?: number; message: string }

export const createInvoiceDraft = (lines: { fulfilment_line_id: string; quantity?: number }[], header: InvoiceHeaderInput, key: string) =>
  rpc<{ invoice_id: string; lines: number; duplicate?: boolean }>('sales_invoice_create_draft', { p_lines: lines, p_header: header, p_idempotency_key: key })

export const updateInvoiceDraft = (
  id: string,
  input: { header?: InvoiceHeaderInput | null; lines?: { line_id: string; quantity?: number; unit_price?: number | null; discount_percent?: number; discount_amount?: number }[] | null; charge?: { amount: number } | null; removeLineIds?: string[] | null },
) =>
  rpc<{ invoice_id: string; issues: ValidationIssue[] }>('sales_invoice_update_draft', {
    p_invoice_id: id,
    p_header: input.header ?? null,
    p_lines: input.lines ?? null,
    p_charge: input.charge ?? null,
    p_remove_line_ids: input.removeLineIds ?? null,
  })

export const validateInvoice = (id: string) => rpc<ValidationIssue[]>('sales_invoice_validate', { p_invoice_id: id })

export type InvoiceAction = 'SUBMIT' | 'RETURN_TO_DRAFT' | 'ACK_TAX_REVIEW' | 'REFRESH' | 'DISCARD' | 'CANCEL'
export const invoiceAction = (id: string, action: InvoiceAction, note: string | null) => rpc<{ status: string }>('sales_invoice_action', { p_invoice_id: id, p_action: action, p_note: note })
export const issueInvoice = (id: string, key: string) =>
  rpc<{ invoice_id: string; invoice_number: string; financial_year: string; grand_total: number; duplicate?: boolean }>('sales_invoice_issue', { p_invoice_id: id, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export async function fetchPayments(f: { customerId?: string | null; unallocatedOnly?: boolean; status?: 'RECORDED' | 'REVERSED' | null; from?: string | null; to?: string | null }): Promise<CustomerPaymentListRow[]> {
  let query = db().from('customer_payment_list').select('*').order('receipt_date', { ascending: false }).order('receipt_number', { ascending: false }).limit(2000)
  if (f.customerId) query = query.eq('customer_id', f.customerId)
  if (f.unallocatedOnly) query = query.eq('status', 'RECORDED').gt('unallocated_amount', 0)
  if (f.status) query = query.eq('status', f.status)
  if (f.from) query = query.gte('receipt_date', f.from)
  if (f.to) query = query.lte('receipt_date', f.to)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as CustomerPaymentListRow[]
}

export async function fetchAllocations(f: { paymentId?: string; invoiceId?: string }): Promise<PaymentAllocationListRow[]> {
  let query = db().from('invoice_payment_allocation_list').select('*').order('created_at')
  if (f.paymentId) query = query.eq('payment_id', f.paymentId)
  if (f.invoiceId) query = query.eq('invoice_id', f.invoiceId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as PaymentAllocationListRow[]
}

export const recordPayment = (
  payment: { customer_id: string; receipt_date: string; amount: string; payment_method: PaymentMethod; transaction_reference: string | null; bank_reference: string | null; notes: string | null },
  allocations: { invoice_id: string; amount: string }[],
  key: string,
) => rpc<{ payment_id: string; receipt_number: string; allocations: number; unallocated: number; duplicate?: boolean }>('customer_payment_record', {
  p_payment: payment,
  p_allocations: allocations,
  p_idempotency_key: key,
})

export const allocatePayment = (paymentId: string, allocations: { invoice_id: string; amount: string }[], key: string) =>
  rpc<{ allocations: number; unallocated: number }>('customer_payment_allocate', { p_payment_id: paymentId, p_allocations: allocations, p_idempotency_key: key })
export const reverseAllocation = (id: string, reason: string) => rpc<{ status: string; invoice_balance: number }>('payment_allocation_reverse', { p_allocation_id: id, p_reason: reason })
export const reversePayment = (id: string, reason: string, key: string) =>
  rpc<{ status: string; allocations_reversed: number }>('customer_payment_reverse', { p_payment_id: id, p_reason: reason, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Credit and debit notes
// ---------------------------------------------------------------------------
export async function fetchNotes(f: { type?: NoteType; invoiceId?: string; status?: NoteStatus | null }): Promise<AdjustmentNoteListRow[]> {
  let query = db().from('adjustment_note_list').select('*').neq('status', 'DISCARDED').order('created_at', { ascending: false }).limit(2000)
  if (f.type) query = query.eq('note_type', f.type)
  if (f.invoiceId) query = query.eq('original_invoice_id', f.invoiceId)
  if (f.status) query = query.eq('status', f.status)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as AdjustmentNoteListRow[]
}

export async function fetchNote(id: string): Promise<AdjustmentNoteListRow> {
  const { data, error } = await db().from('adjustment_note_list').select('*').eq('id', id).single()
  if (error) throw error
  return data as AdjustmentNoteListRow
}

export async function fetchNoteLines(noteId: string): Promise<AdjustmentNoteLineRow[]> {
  const { data, error } = await db().from('invoice_adjustment_note_lines').select('*').eq('note_id', noteId).order('line_no')
  if (error) throw error
  return data ?? []
}

export const createNote = (
  invoiceId: string,
  type: NoteType,
  header: { note_date: string; reason_code: NoteReason; reason: string; supporting_reference: string | null; customer_return_id: string | null },
  lines: { invoice_line_id: string; quantity?: string; taxable_amount?: string; customer_return_line_id?: string | null }[],
  key: string,
) => rpc<{ note_id: string; issues: ValidationIssue[] }>('adjustment_note_create', { p_invoice_id: invoiceId, p_type: type, p_header: header, p_lines: lines, p_idempotency_key: key })

export type NoteAction = 'SUBMIT' | 'RETURN_TO_DRAFT' | 'ACK_TAX_REVIEW' | 'DISCARD' | 'CANCEL'
export const noteAction = (id: string, action: NoteAction, note: string | null) => rpc<{ status: string }>('adjustment_note_action', { p_note_id: id, p_action: action, p_note: note })
export const issueNote = (id: string, key: string) => rpc<{ note_id: string; note_number: string; total: number }>('adjustment_note_issue', { p_note_id: id, p_idempotency_key: key })
export const validateNote = (id: string) => rpc<ValidationIssue[]>('adjustment_note_validate', { p_note_id: id })

// ---------------------------------------------------------------------------
// Receivables, statements, overview, reports
// ---------------------------------------------------------------------------
export interface ReceivableRow {
  invoice_id: string
  invoice_number: string
  invoice_date: string
  due_date: string
  customer_id: string
  customer_name: string
  customer_code: string
  grand_total: number
  credited: number
  debited: number
  paid: number
  balance: number
  days_overdue: number
  bucket: AgeingBucket
}
export type AgeingBucket = 'NOT_DUE' | '1_30' | '31_60' | '61_90' | 'OVER_90'

export const fetchReceivables = (asOf: string, customerId: string | null, bucket: AgeingBucket | null) =>
  rpc<ReceivableRow[]>('billing_receivables', { p_as_of: asOf, p_customer_id: customerId, p_bucket: bucket })

export interface CustomerStatement {
  customer: { id: string; customer_code: string; name: string; billing_address: string | null; gstin: string | null }
  company: { legal_name: string; legal_address: string | null; gstin: string | null }
  from: string
  to: string
  opening_balance: number
  closing_balance: number
  unallocated_receipts: number
  entries: { date: string; document: string; description: string; debit: number; credit: number; balance: number }[]
  generated_at: string
}
export const fetchStatement = (customerId: string, from: string, to: string) =>
  rpc<CustomerStatement>('billing_customer_statement', { p_customer_id: customerId, p_from: from, p_to: to })

export interface BillingOverview {
  has_records: boolean
  currency: string
  invoiced_total: number
  received_total: number
  outstanding_total: number
  overdue_total: number
  customer_credit_total: number
  unallocated_receipts_total: number
  invoices_issued: number
  drafts_awaiting: number
  pending_approval: number
  partially_paid: number
  fully_paid: number
  monthly: { month: string; invoiced: number; collected: number }[]
  outstanding_by_customer: { customer_id: string; customer_name: string; balance: number; overdue: number | null }[]
  ageing: { bucket: AgeingBucket; amount: number; invoices: number }[]
  top_customers: { customer_id: string; customer_name: string; invoiced: number; invoices: number }[]
  recent_invoices: { id: string; invoice_number: string; invoice_date: string; customer_legal_name: string; grand_total: number; balance_due: number; display_status: InvoiceDisplayStatus }[]
  recent_receipts: { id: string; receipt_number: string; receipt_date: string; customer_name: string; amount_received: number; unallocated_amount: number; payment_method: PaymentMethod; status: string }[]
  overdue_invoices: { invoice_id: string; invoice_number: string; customer_name: string; due_date: string; balance: number; days_overdue: number }[]
  as_of: string
  today: string
}
export const fetchBillingOverview = (f: { from: string; to: string; customerId: string | null; status: string | null; paymentStatus: string | null }) =>
  rpc<BillingOverview>('billing_overview', { p_from: f.from, p_to: f.to, p_customer_id: f.customerId, p_status: f.status, p_payment_status: f.paymentStatus })

export type BillingReportKey =
  | 'INVOICES'
  | 'BY_GST_RATE'
  | 'TAX_COMPONENTS'
  | 'HSN_SUMMARY'
  | 'CUSTOMER_WISE'
  | 'MONTHLY_INVOICING'
  | 'COLLECTIONS_BY_MONTH'
  | 'OUTSTANDING'
  | 'OVERDUE'
  | 'NOTES'
  | 'UNALLOCATED_RECEIPTS'
  | 'CANCELLED'
export const fetchBillingReport = (report: BillingReportKey, f: { from: string; to: string; customerId: string | null; status: string | null }) =>
  rpc<Record<string, unknown>[]>('billing_report', { p_report: report, p_from: f.from, p_to: f.to, p_customer_id: f.customerId, p_status: f.status })
