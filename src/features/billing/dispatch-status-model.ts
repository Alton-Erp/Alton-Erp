// Dispatch-before-posting status of an invoice (public.invoice_dispatch_status).
// Pure helpers: labels, the summary shown above the Post button, and the reason
// posting is disabled. The database is the authority; this only presents it.

/** DISPATCH_ON_POSTING (since 20261115): a sales-order stock line that posting the invoice dispatches. */
export type DispatchLineStatus = 'NOT_APPLICABLE' | 'AWAITING_DISPATCH' | 'PARTIALLY_DISPATCHED' | 'FULLY_DISPATCHED' | 'DISPATCH_ON_POSTING'

export interface InvoiceDispatchLine {
  line_no: number
  line_type: 'PRODUCT' | 'CHARGE'
  product_id: string | null
  sku: string | null
  product_name: string | null
  unit: string | null
  applies: boolean
  required: number
  dispatched: number | null
  remaining: number
  status: DispatchLineStatus
  reason: string | null
  sales_order_id: string | null
  sales_order_number: string | null
  /** Quantity dispatched automatically when the invoice is posted. */
  dispatch_on_posting?: number
}

export interface InvoiceDispatchStatus {
  invoice_id: string
  invoice_status: string
  sales_order_id: string | null
  lines: InvoiceDispatchLine[]
  stock_lines: number
  outstanding_lines: number
  dispatch_on_posting_lines?: number
  ready: boolean
  checked_at: string
}

export interface DispatchExceptionRow {
  invoice_id: string
  invoice_number: string
  invoice_date: string
  customer: string
  source: string
  line_no: number
  sku: string | null
  product_name: string | null
  unit: string | null
  invoiced: number
  covered: number
  uncovered: number
  reason: string | null
}

export const DISPATCH_STATUS_LABEL: Record<DispatchLineStatus, string> = {
  NOT_APPLICABLE: 'No dispatch needed',
  AWAITING_DISPATCH: 'Awaiting Dispatch',
  PARTIALLY_DISPATCHED: 'Partially Dispatched',
  FULLY_DISPATCHED: 'Fully Dispatched',
  DISPATCH_ON_POSTING: 'Dispatched on posting',
}

export type InvoiceDispatchState = 'READY_TO_POST' | 'AWAITING_DISPATCH' | 'PARTIALLY_DISPATCHED' | 'NO_STOCK_LINES' | 'DISPATCH_ON_POSTING'

/** Overall state of the invoice for the badge above the Post button. */
export function invoiceDispatchState(s: Pick<InvoiceDispatchStatus, 'lines' | 'ready' | 'stock_lines'>): InvoiceDispatchState {
  if (s.stock_lines === 0) return 'NO_STOCK_LINES'
  if (s.ready) return s.lines.some((l) => l.status === 'DISPATCH_ON_POSTING') ? 'DISPATCH_ON_POSTING' : 'READY_TO_POST'
  const stock = s.lines.filter((l) => l.applies)
  return stock.some((l) => (l.dispatched ?? 0) > 0) ? 'PARTIALLY_DISPATCHED' : 'AWAITING_DISPATCH'
}

export const INVOICE_DISPATCH_STATE_LABEL: Record<InvoiceDispatchState, string> = {
  READY_TO_POST: 'Ready to Post',
  AWAITING_DISPATCH: 'Awaiting Dispatch',
  PARTIALLY_DISPATCHED: 'Partially Dispatched',
  NO_STOCK_LINES: 'Ready to Post (no stock items)',
  DISPATCH_ON_POSTING: 'Ready to Post – goods dispatched on posting',
}

const qty = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** Why posting is disabled, or null when it may be posted. One sentence per outstanding line. */
export function postingBlockedReason(s: Pick<InvoiceDispatchStatus, 'lines' | 'ready'> | null | undefined): string | null {
  if (!s || s.ready) return null
  const parts = s.lines.filter((l) => l.applies && l.remaining > 0 && l.status !== 'DISPATCH_ON_POSTING').map((l) =>
    `${l.sku ?? 'Line ' + l.line_no} ${l.product_name ?? ''}: ${qty(l.remaining)} ${l.unit ?? ''} of ${qty(l.required)} still to dispatch`.replace(/\s+/g, ' ').trim())
  return parts.length === 0 ? null : `Dispatch the goods before posting. ${parts.join('; ')}.`
}

/** Distinct sales orders the outstanding lines belong to (for "Go to dispatch" links). */
export function ordersToDispatch(s: Pick<InvoiceDispatchStatus, 'lines'> | null | undefined): { id: string; number: string }[] {
  const seen = new Map<string, string>()
  for (const l of s?.lines ?? []) {
    if (l.applies && l.remaining > 0 && l.status !== 'DISPATCH_ON_POSTING' && l.sales_order_id && !seen.has(l.sales_order_id)) seen.set(l.sales_order_id, l.sales_order_number ?? 'Sales order')
  }
  return [...seen].map(([id, number]) => ({ id, number }))
}

/** Excel layout of the historical exceptions report. */
export function dispatchExceptionsSheet(rows: DispatchExceptionRow[]): (string | number)[][] {
  return [
    ['Invoice', 'Date', 'Customer', 'Source', 'Line', 'SKU', 'Product', 'Unit', 'Invoiced', 'Covered by dispatch', 'Not covered', 'Reason'],
    ...rows.map((r) => [r.invoice_number, r.invoice_date, r.customer, r.source, r.line_no, r.sku ?? '', r.product_name ?? '', r.unit ?? '',
      Number(r.invoiced), Number(r.covered), Number(r.uncovered), r.reason ?? '']),
  ]
}
