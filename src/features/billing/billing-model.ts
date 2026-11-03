import type { Tone } from '@/config/status'

/** Display labels and tones (grey draft, blue issued, orange partial / review, green paid, red overdue / critical). */
export const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  ISSUED: 'Issued',
  PARTIALLY_PAID: 'Partially paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
  DISCARDED: 'Discarded',
}

export const INVOICE_STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  ISSUED: 'info',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
  OVERDUE: 'danger',
  CANCELLED: 'neutral',
  DISCARDED: 'neutral',
}

export const NOTE_STATUS_LABELS: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', ISSUED: 'Issued', CANCELLED: 'Cancelled', DISCARDED: 'Discarded' }
export const NOTE_STATUS_TONE: Record<string, Tone> = { DRAFT: 'neutral', PENDING_APPROVAL: 'warning', ISSUED: 'info', CANCELLED: 'neutral', DISCARDED: 'neutral' }

export const NOTE_REASON_LABELS: Record<string, string> = {
  SALES_RETURN: 'Sales return',
  QUALITY_ISSUE: 'Quality issue',
  PRICE_CORRECTION: 'Pricing correction',
  SHORT_SUPPLY: 'Short supply',
  COMMERCIAL_ADJUSTMENT: 'Agreed commercial adjustment',
  ADDITIONAL_CHARGE: 'Additional charge',
  OTHER: 'Other',
}
export const CREDIT_REASONS = ['SALES_RETURN', 'QUALITY_ISSUE', 'PRICE_CORRECTION', 'SHORT_SUPPLY', 'COMMERCIAL_ADJUSTMENT', 'OTHER'] as const
export const DEBIT_REASONS = ['PRICE_CORRECTION', 'ADDITIONAL_CHARGE', 'COMMERCIAL_ADJUSTMENT', 'OTHER'] as const

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  BANK_TRANSFER: 'Bank transfer (NEFT/RTGS/IMPS)',
  UPI: 'UPI',
  CHEQUE: 'Cheque',
  CASH: 'Cash',
  CARD: 'Card',
  DEMAND_DRAFT: 'Demand draft',
  OTHER: 'Other',
}

export const SUPPLY_CATEGORY_LABELS: Record<string, string> = { TAXABLE: 'Taxable', EXEMPT: 'Exempt', ZERO_RATED: 'Zero-rated', NON_GST: 'Non-GST' }
export const TAX_TREATMENT_LABELS: Record<string, string> = {
  INTRA_STATE: 'Intra-state (CGST + SGST)',
  INTER_STATE: 'Inter-state (IGST)',
  NONE: 'No GST',
  UNRESOLVED: 'Unresolved',
}
export const GST_TYPE_LABELS: Record<string, string> = {
  REGISTERED: 'Registered (regular)',
  COMPOSITION: 'Registered (composition)',
  UNREGISTERED: 'Unregistered business',
  CONSUMER: 'Consumer (B2C)',
  SEZ: 'SEZ unit / developer',
  OVERSEAS: 'Overseas',
}
export const BUCKET_LABELS: Record<string, string> = { NOT_DUE: 'Not yet due', '1_30': '1–30 days', '31_60': '31–60 days', '61_90': '61–90 days', OVER_90: 'Over 90 days' }
export const BUCKETS = ['NOT_DUE', '1_30', '31_60', '61_90', 'OVER_90'] as const

export const BILLING_EVENT_LABELS: Record<string, string> = {
  DRAFT_CREATED: 'Draft created',
  DRAFT_UPDATED: 'Draft edited',
  REFRESH: 'Refreshed from master data',
  SUBMIT: 'Submitted for approval',
  RETURN_TO_DRAFT: 'Returned to draft',
  ACK_TAX_REVIEW: 'Tax review acknowledged',
  ISSUED: 'Issued',
  DISCARD: 'Draft discarded',
  CANCEL: 'Cancelled',
  ALLOCATED: 'Payment allocated',
  REVERSED: 'Reversed',
  RECORDED: 'Receipt recorded',
  UPDATED: 'Settings updated',
  TAX_REVIEW_CONFIRMED: 'Review points confirmed when issuing',
  PROFORMA_CONVERTED: 'Proforma converted to a tax invoice',
}

const MONEY = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MONEY_CUR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Two-decimal Indian formatting for display (values come from the database). */
export const money = (v: number | string | null | undefined, withSymbol = true) =>
  v === null || v === undefined || v === '' ? '—' : (withSymbol ? MONEY_CUR : MONEY).format(Number(v))

/** A user-entered amount: digits with at most 2 decimals (kept as a string, validated by the server too). */
export const isAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim())

/** Financial year (April–March by default) containing a date, as an ISO range. */
export function financialYearRange(date: Date, startMonth = 4): { label: string; from: string; to: string } {
  const y = date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1
  if (startMonth === 1) return { label: String(y), from: `${y}-01-01`, to: `${y}-12-31` }
  const end = new Date(y + 1, startMonth - 1, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { label: `${y}-${String((y + 1) % 100).padStart(2, '0')}`, from: `${y}-${pad(startMonth)}-01`, to: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}` }
}

/** The last `count` financial years ending with the current one. */
export function recentFinancialYears(count = 5, startMonth = 4, today = new Date()) {
  return Array.from({ length: count }, (_, i) => financialYearRange(new Date(today.getFullYear() - i, today.getMonth(), Math.min(today.getDate(), 28)), startMonth))
}
