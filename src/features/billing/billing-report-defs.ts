import { BUCKET_LABELS, INVOICE_STATUS_LABELS, NOTE_REASON_LABELS, NOTE_STATUS_LABELS, PAYMENT_METHOD_LABELS, TAX_TREATMENT_LABELS, money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { formatDate } from '@/lib/format'
import type { BillingReportKey } from '@/services/billing'

/** Column definitions of the server-side billing reports (public.billing_report). */
export type Kind = 'text' | 'money' | 'date' | 'qty' | 'int' | 'rate' | 'label'
export type Col = { key: string; label: string; kind?: Kind; labels?: Record<string, string> }

const DOC_LABELS: Record<string, string> = { INVOICES: 'Invoices', CREDIT_NOTES: 'Credit notes', DEBIT_NOTES: 'Debit notes', INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', DEBIT_NOTE: 'Debit note', RECEIPT: 'Receipt' }
const NOTE_TYPE: Record<string, string> = { CREDIT: 'Credit', DEBIT: 'Debit' }
const STATUS_LABELS = { ...INVOICE_STATUS_LABELS, ...NOTE_STATUS_LABELS }

const TAX_COLS: Col[] = [
  { key: 'taxable_value', label: 'Taxable value', kind: 'money' }, { key: 'cgst', label: 'CGST', kind: 'money' }, { key: 'sgst', label: 'SGST', kind: 'money' }, { key: 'igst', label: 'IGST', kind: 'money' },
]
const POSITION_COLS: Col[] = [
  { key: 'invoice_number', label: 'Invoice' }, { key: 'invoice_date', label: 'Date', kind: 'date' }, { key: 'customer_name', label: 'Customer' }, { key: 'due_date', label: 'Due', kind: 'date' },
  { key: 'days_overdue', label: 'Days overdue', kind: 'int' }, { key: 'bucket', label: 'Bucket', kind: 'label', labels: BUCKET_LABELS }, { key: 'grand_total', label: 'Invoice total', kind: 'money' },
  { key: 'credited', label: 'Credited', kind: 'money' }, { key: 'debited', label: 'Debited', kind: 'money' }, { key: 'paid', label: 'Received', kind: 'money' }, { key: 'balance', label: 'Balance', kind: 'money' },
]

export const REPORTS: Record<BillingReportKey, { title: string; description: string; columns: Col[]; asOf?: boolean; statuses?: string[] }> = {
  INVOICES: {
    title: 'Invoice register', description: 'Issued invoices dated in the period with current payment position.', statuses: ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'],
    columns: [{ key: 'invoice_number', label: 'Invoice' }, { key: 'invoice_date', label: 'Date', kind: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'customer_gstin', label: 'GSTIN' },
      { key: 'place_of_supply', label: 'POS' }, { key: 'tax_treatment', label: 'Treatment', kind: 'label', labels: TAX_TREATMENT_LABELS }, { key: 'taxable_subtotal', label: 'Taxable', kind: 'money' },
      { key: 'cgst_total', label: 'CGST', kind: 'money' }, { key: 'sgst_total', label: 'SGST', kind: 'money' }, { key: 'igst_total', label: 'IGST', kind: 'money' }, { key: 'round_off', label: 'Round-off', kind: 'money' },
      { key: 'grand_total', label: 'Total', kind: 'money' }, { key: 'paid', label: 'Received', kind: 'money' }, { key: 'balance_due', label: 'Balance', kind: 'money' },
      { key: 'display_status', label: 'Status', kind: 'label', labels: STATUS_LABELS }],
  },
  BY_GST_RATE: {
    title: 'Sales by GST rate', description: 'Issued invoices, credit notes and debit notes in the period, by GST rate (notes shown separately, not netted).',
    columns: [{ key: 'document_type', label: 'Documents', kind: 'label', labels: DOC_LABELS }, { key: 'gst_rate', label: 'GST rate', kind: 'rate' }, ...TAX_COLS, { key: 'total', label: 'Total', kind: 'money' }],
  },
  TAX_COMPONENTS: {
    title: 'CGST / SGST / IGST by month', description: 'Issued invoices plus debit notes minus credit notes, by document date.',
    columns: [{ key: 'month', label: 'Month' }, ...TAX_COLS, { key: 'total_tax', label: 'Total tax', kind: 'money' }],
  },
  HSN_SUMMARY: {
    title: 'HSN / SAC summary', description: 'Quantity, taxable value and tax by HSN/SAC, unit and rate (notes shown separately).',
    columns: [{ key: 'document_type', label: 'Documents', kind: 'label', labels: DOC_LABELS }, { key: 'hsn_sac', label: 'HSN/SAC' }, { key: 'unit', label: 'Unit' }, { key: 'gst_rate', label: 'GST rate', kind: 'rate' },
      { key: 'quantity', label: 'Quantity', kind: 'qty' }, ...TAX_COLS, { key: 'total', label: 'Total', kind: 'money' }],
  },
  CUSTOMER_WISE: {
    title: 'Customer-wise invoicing', description: 'Issued invoices in the period by customer, with credits, receipts and balance.',
    columns: [{ key: 'customer_code', label: 'Code' }, { key: 'customer', label: 'Customer' }, { key: 'invoices', label: 'Invoices', kind: 'int' }, { key: 'taxable_value', label: 'Taxable', kind: 'money' },
      { key: 'tax', label: 'GST', kind: 'money' }, { key: 'invoiced', label: 'Invoiced', kind: 'money' }, { key: 'credited', label: 'Credited', kind: 'money' }, { key: 'debited', label: 'Debited', kind: 'money' },
      { key: 'received', label: 'Received', kind: 'money' }, { key: 'balance', label: 'Balance', kind: 'money' }],
  },
  MONTHLY_INVOICING: {
    title: 'Monthly invoicing', description: 'Issued invoices by invoice month.',
    columns: [{ key: 'month', label: 'Month' }, { key: 'invoices', label: 'Invoices', kind: 'int' }, { key: 'taxable_value', label: 'Taxable', kind: 'money' }, { key: 'tax', label: 'GST', kind: 'money' }, { key: 'invoiced', label: 'Invoiced', kind: 'money' }],
  },
  COLLECTIONS_BY_MONTH: {
    title: 'Collections by month', description: 'Recorded receipts by receipt month (user-entered, not bank-verified); reversed receipts shown separately.',
    columns: [{ key: 'month', label: 'Month' }, { key: 'receipts', label: 'Receipts', kind: 'int' }, { key: 'received', label: 'Received', kind: 'money' }, { key: 'reversed_receipts', label: 'Reversed', kind: 'int' }, { key: 'reversed_amount', label: 'Reversed amount', kind: 'money' }],
  },
  OUTSTANDING: { title: 'Outstanding invoices', description: 'Open balances as of the period end date.', columns: POSITION_COLS, asOf: true },
  OVERDUE: { title: 'Overdue invoices', description: 'Balances past their due date as of the period end date.', columns: POSITION_COLS, asOf: true },
  NOTES: {
    title: 'Credit and debit notes', description: 'Issued and cancelled notes dated in the period.', statuses: ['ISSUED', 'CANCELLED'],
    columns: [{ key: 'note_number', label: 'Note' }, { key: 'note_type', label: 'Type', kind: 'label', labels: NOTE_TYPE }, { key: 'note_date', label: 'Date', kind: 'date' }, { key: 'customer', label: 'Customer' },
      { key: 'invoice_number', label: 'Invoice' }, { key: 'reason_code', label: 'Reason', kind: 'label', labels: NOTE_REASON_LABELS }, { key: 'taxable_amount', label: 'Taxable', kind: 'money' },
      { key: 'cgst_amount', label: 'CGST', kind: 'money' }, { key: 'sgst_amount', label: 'SGST', kind: 'money' }, { key: 'igst_amount', label: 'IGST', kind: 'money' }, { key: 'total_amount', label: 'Total', kind: 'money' },
      { key: 'status', label: 'Status', kind: 'label', labels: STATUS_LABELS }],
  },
  UNALLOCATED_RECEIPTS: {
    title: 'Unallocated receipts', description: 'Recorded receipts dated up to the period end that are not fully allocated (current allocation position).', asOf: true,
    columns: [{ key: 'receipt_number', label: 'Receipt' }, { key: 'receipt_date', label: 'Date', kind: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'payment_method', label: 'Method', kind: 'label', labels: PAYMENT_METHOD_LABELS },
      { key: 'transaction_reference', label: 'Reference' }, { key: 'amount_received', label: 'Received', kind: 'money' }, { key: 'allocated_amount', label: 'Allocated', kind: 'money' }, { key: 'unallocated_amount', label: 'Unallocated', kind: 'money' }],
  },
  CANCELLED: {
    title: 'Cancelled documents and reversed receipts', description: 'Invoices and notes cancelled, and receipts reversed, in the period.',
    columns: [{ key: 'document_type', label: 'Document', kind: 'label', labels: DOC_LABELS }, { key: 'document_number', label: 'Number' }, { key: 'document_date', label: 'Document date', kind: 'date' },
      { key: 'cancelled_date', label: 'Cancelled / reversed', kind: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'reason', label: 'Reason' }],
  },
}

export type Row = Record<string, unknown>

export function display(c: Col, v: unknown) {
  if (v === null || v === undefined || v === '') return '—'
  switch (c.kind) {
    case 'money': return money(v as number, false)
    case 'date': return formatDate(String(v))
    case 'qty': return formatQty(Number(v))
    case 'rate': return `${Number(v)}%`
    case 'label': return c.labels?.[String(v)] ?? String(v)
    default: return String(v)
  }
}

export function exportValue(c: Col, v: unknown) {
  if (v === null || v === undefined) return null
  if (c.kind === 'money' || c.kind === 'qty' || c.kind === 'int' || c.kind === 'rate') return Number(v)
  if (c.kind === 'label') return c.labels?.[String(v)] ?? String(v)
  return String(v)
}
