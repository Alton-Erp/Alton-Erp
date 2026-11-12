import type { ReviewFlag } from '@/features/management/gst-basis'
import { requireSupabase } from '@/lib/supabase'

/**
 * GST-exclusive dashboard figures (migration 20261209090000, public.gst_exclusive_dashboard).
 * Read-only: amounts are the documents' taxable values; CGST, SGST and IGST are left out. Outstanding
 * balances are given only where the records allow it; partly paid balances are flagged for review.
 */
export type ExclGstScope = 'MANAGEMENT' | 'PURCHASE' | 'GRN' | 'SALES' | 'BILLING' | 'LEDGER'

export type { ReviewFlag }
type Unavailable = { available: false; reason: string }

export interface ExclGstPurchase {
  available: true
  period_value: number
  outstanding_receipt_value: number
  received_value: number
  top_suppliers: { supplier: string; value: number; orders: number }[]
  monthly: { month: string; ordered: number; received: number }[]
}
export interface ExclGstSales {
  available: true
  total_value: number
  order_value: number
  daily: { day: string; value: number; orders: number }[]
  /** Taxable total per sales order id (the dashboard's recent orders). */
  orders: Record<string, number>
}
export interface ExclGstInvoicing {
  available: true
  taxable_value: number
  gst: number
  invoices: number
  outstanding_excl_gst: number
  outstanding_review: ReviewFlag
  overdue_excl_gst: number
  overdue_review: ReviewFlag
  monthly: { month: string; taxable: number; gst: number; received: number }[]
  by_invoice: Record<string, { taxable: number; outstanding_excl_gst: number | null; status: 'EXACT' | 'SETTLED' | 'REVIEW' | null }>
}
export interface ExclGstBalances { outstanding_excl_gst: number; outstanding_incl_gst: number; review_count: number; review_balance: number }

export interface ExclGstDashboard {
  scope: ExclGstScope
  basis: 'EXCL_GST'
  purchase?: ExclGstPurchase | Unavailable
  sales?: ExclGstSales | Unavailable
  invoicing?: ExclGstInvoicing | Unavailable
  // MANAGEMENT
  sales_invoiced?: number
  invoices?: number
  receivables?: ExclGstBalances
  payables?: ExclGstBalances
  customer_outstanding?: { party_id: string; outstanding_excl_gst: number; overdue_excl_gst: number; review_invoices: number; review_balance: number }[]
  // LEDGER
  receivables_excl_gst?: number
  receivables_review?: ReviewFlag
  payables_excl_gst?: number
  payables_review?: ReviewFlag
  by_party?: Record<string, { receivable_excl_gst: number | null; receivable_status: string; payable_excl_gst: number | null; payable_status: string }>
  top_customers?: { party_id: string; invoiced: number }[]
  top_suppliers?: { party_id: string; received: number }[]
}

export const exclOk = <T extends { available: true }>(s: T | Unavailable | undefined | null): s is T => Boolean(s && s.available)

const isMissing = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code
  return code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01'
}

/** Null before the migration is applied (the dashboards then say the GST-exclusive figures are unavailable). */
export async function fetchExclGst(scope: ExclGstScope, from: string, to: string,
  filters: { customerId?: string | null; status?: string | null; paymentStatus?: string | null } = {}): Promise<ExclGstDashboard | null> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: ExclGstDashboard; error: unknown }>)(
    'gst_exclusive_dashboard',
    { p_scope: scope, p_from: from, p_to: to, p_customer_id: filters.customerId ?? null, p_status: filters.status ?? null, p_payment_status: filters.paymentStatus ?? null })
  if (error) {
    if (isMissing(error)) return null
    throw error
  }
  return data
}

export { EXCL_GST_MISSING, EXCL_GST_NOTE, reviewText } from '@/features/management/gst-basis'
