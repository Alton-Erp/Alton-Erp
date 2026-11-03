// Sales order invoicing status, the Pending / Incomplete Invoice Orders register and
// its reports (public.sales_invoice_tracking, migration 20261115090000). Pure
// TypeScript (no React/Supabase) so it is unit-tested. Pending quantities are a
// tracking figure only: they are never stock and never part of on-hand quantities.

export type InvoiceLineStatus = 'OPEN' | 'PARTIALLY_INVOICED' | 'FULLY_INVOICED' | 'PARTIALLY_RELEASED' | 'CLOSED' | 'CANCELLED'

export interface TrackingLine {
  sales_order_id: string
  sales_order_number: string
  order_date: string
  order_status: string
  customer_id: string | null
  customer_name: string
  line_id: string
  line_no: number
  product_id: string
  sku: string
  product_name: string
  unit: string
  ordered: number
  cancelled: number
  released: number
  effective: number
  invoiced: number
  draft_invoiced: number
  dispatched: number
  pending: number
  releasable: number
  invoice_numbers: string[] | null
  latest_invoice_id: string | null
  latest_invoice_number: string | null
  latest_invoice_date: string | null
  status: InvoiceLineStatus
}

export interface PartialInvoiceRow {
  invoice_id: string
  invoice_number: string
  invoice_date: string
  customer: string
  sales_orders: string
  posted_by: string
  posted_at: string
  lines: { sales_order_number: string; sku: string; product_name: string; unit: string; ordered: number; previously_invoiced: number; this_invoice: number; remaining: number }[]
}

export interface ReleaseRow {
  sales_order_id: string
  sales_order_number: string
  customer: string
  sku: string
  product_name: string
  unit: string
  quantity: number
  ordered: number
  invoiced: number
  invoice_numbers: string[] | null
  reason: string
  released_by: string
  released_at: string
}

export interface TrackingResult {
  lines: TrackingLine[]
  totals: { unit: string; ordered: number; invoiced: number; pending: number; released: number }[]
  partial_invoices: PartialInvoiceRow[]
  releases: ReleaseRow[]
  checked_at: string
}

export const NON_STOCK_LABEL = 'Non-stock tracking quantity – excluded from actual inventory.'

export const INVOICE_STATUS_LABEL: Record<InvoiceLineStatus, string> = {
  OPEN: 'Open',
  PARTIALLY_INVOICED: 'Partially Invoiced',
  FULLY_INVOICED: 'Fully Invoiced',
  PARTIALLY_RELEASED: 'Partially Released',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
}

/** Register status column: lines with something pending are "Partially Invoiced" or "Pending Invoice". */
export const registerStatus = (l: Pick<TrackingLine, 'invoiced' | 'pending' | 'status'>): string =>
  l.pending > 0 ? (Number(l.invoiced) > 0 ? 'Partially Invoiced' : 'Pending Invoice') : INVOICE_STATUS_LABEL[l.status]

const qty = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** Pending quantities per unit, e.g. "2 PCS" or "2 PCS + 1.5 KG". */
export function pendingText(lines: Pick<TrackingLine, 'pending' | 'unit'>[]): string {
  const byUnit = new Map<string, number>()
  for (const l of lines) if (Number(l.pending) > 0) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + Number(l.pending))
  return [...byUnit].map(([u, n]) => `${qty(n)} ${u}`).join(' + ')
}

/** Order-level invoicing status from its lines. */
export function orderInvoiceStatus(lines: Pick<TrackingLine, 'status' | 'invoiced' | 'pending' | 'released' | 'cancelled'>[]): InvoiceLineStatus {
  if (lines.length === 0) return 'OPEN'
  if (lines.every((l) => l.status === 'CANCELLED')) return 'CANCELLED'
  const live = lines.filter((l) => l.status !== 'CANCELLED')
  const pending = live.some((l) => Number(l.pending) > 0)
  const released = live.some((l) => Number(l.released) > 0)
  if (!pending) return released || live.some((l) => Number(l.cancelled) > 0) ? 'CLOSED' : 'FULLY_INVOICED'
  if (released) return 'PARTIALLY_RELEASED'
  if (live.some((l) => Number(l.invoiced) > 0)) return 'PARTIALLY_INVOICED'
  return 'OPEN'
}

/** "Partially Invoiced – 2 PCS Pending", "Fully Invoiced", "Open – 10 PCS Pending". */
export function orderInvoiceLabel(lines: TrackingLine[]): string {
  const status = orderInvoiceStatus(lines)
  const pending = pendingText(lines)
  return pending && status !== 'CANCELLED' ? `${INVOICE_STATUS_LABEL[status]} – ${pending} Pending` : INVOICE_STATUS_LABEL[status]
}

/** Partial-invoice warning text (section 4 of the spec), or null when the invoice covers what remains. */
export function partialWarning(lines: { sales_order_number: string; sku: string; unit: string; ordered: number; previously_invoiced: number; this_invoice: number; remaining: number }[]): string[] | null {
  const partial = lines.filter((l) => Number(l.remaining) > 0)
  if (partial.length === 0) return null
  return partial.map((l) => {
    const prev = Number(l.previously_invoiced) > 0 ? ` (${qty(l.previously_invoiced)} ${l.unit} already invoiced)` : ''
    return `You are creating an invoice for ${qty(l.this_invoice)} ${l.unit} of ${l.sku} against Sales Order ${l.sales_order_number} of ${qty(l.ordered)} ${l.unit}${prev}. `
      + `The remaining ${qty(l.remaining)} ${l.unit} will stay pending for future invoicing. They will not be added to actual inventory.`
  })
}

export interface TrackingFilters {
  search: string
  invoiceNumber: string
  customerId: string
  from: string
  to: string
}

/** Release quantity problem, or null. */
export function releaseProblem(value: string, releasable: number, unit: string, reason: string): string | null {
  const v = value.trim()
  if (!/^\d+(\.\d{1,3})?$/.test(v) || Number(v) <= 0) return 'Enter the quantity to release.'
  if (['PCS', 'NOS', 'SET', 'PAIR'].includes(unit) && !Number.isInteger(Number(v))) return `${unit} are released in whole pieces.`
  if (Number(v) > releasable) return `Only ${qty(releasable)} ${unit} can be released. Invoiced quantities, quantities on draft invoices and dispatched goods cannot be released.`
  if (reason.trim().length < 5) return 'Give the reason for the release (at least 5 characters).'
  return null
}

// ---------------------------------------------------------------------------
// Excel exports: the register and the five reports
// ---------------------------------------------------------------------------
type Sheet = (string | number)[][]
const n = (v: number | null | undefined) => (v == null ? 0 : Number(v))

export function registerSheet(lines: TrackingLine[]): Sheet {
  return [
    ['Sales Order No.', 'Invoice No.', 'Customer', 'Product SKU', 'Product Name', 'Ordered Qty', 'Invoiced Qty', 'Pending Invoice Qty', 'Released Qty', 'Unit',
      'Order Date', 'Invoice Date', 'Status', 'Note'],
    ...lines.map((l) => [l.sales_order_number, (l.invoice_numbers ?? []).join(', '), l.customer_name, l.sku, l.product_name, n(l.ordered), n(l.invoiced), n(l.pending),
      n(l.released), l.unit, l.order_date, l.latest_invoice_date ?? '', registerStatus(l), NON_STOCK_LABEL]),
  ]
}

export function partialInvoiceSheet(rows: PartialInvoiceRow[]): Sheet {
  return [
    ['Invoice No.', 'Invoice Date', 'Customer', 'Sales Order No.', 'Product SKU', 'Product Name', 'Ordered Qty', 'Previously Invoiced', 'This Invoice', 'Remaining at Posting', 'Unit', 'Posted By', 'Posted At'],
    ...rows.flatMap((r) => r.lines.map((l) => [r.invoice_number, r.invoice_date, r.customer, l.sales_order_number, l.sku, l.product_name, n(l.ordered), n(l.previously_invoiced),
      n(l.this_invoice), n(l.remaining), l.unit, r.posted_by, r.posted_at])),
  ]
}

export function reconciliationSheet(lines: TrackingLine[]): Sheet {
  return [
    ['Sales Order No.', 'Customer', 'Product SKU', 'Product Name', 'Unit', 'Ordered Qty', 'Released Qty', 'Other Cancelled Qty', 'Invoiced Qty (posted)', 'On Draft Invoices',
      'Dispatched Qty', 'Pending Invoice Qty', 'Check', 'Status'],
    ...lines.map((l) => {
      const balanced = Math.abs(n(l.ordered) - n(l.released) - n(l.cancelled) - n(l.invoiced) - n(l.pending)) < 0.0005
        || (n(l.pending) === 0 && n(l.invoiced) >= n(l.effective))
      return [l.sales_order_number, l.customer_name, l.sku, l.product_name, l.unit, n(l.ordered), n(l.released), n(l.cancelled), n(l.invoiced), n(l.draft_invoiced),
        n(l.dispatched), n(l.pending), balanced ? 'OK' : 'Check', INVOICE_STATUS_LABEL[l.status]]
    }),
  ]
}

export function releasedSheet(rows: ReleaseRow[]): Sheet {
  return [
    ['Sales Order No.', 'Customer', 'Product SKU', 'Product Name', 'Unit', 'Ordered Qty', 'Invoiced Qty', 'Released Qty', 'Invoice No.', 'Reason', 'Released By', 'Released At'],
    ...rows.map((r) => [r.sales_order_number, r.customer, r.sku, r.product_name, r.unit, n(r.ordered), n(r.invoiced), n(r.quantity), (r.invoice_numbers ?? []).join(', '),
      r.reason, r.released_by, r.released_at]),
  ]
}

/** Customer-wise pending invoice quantities (per unit). */
export function customerPending(lines: TrackingLine[]): { customer: string; unit: string; orders: number; ordered: number; invoiced: number; pending: number; released: number }[] {
  const map = new Map<string, { customer: string; unit: string; orders: Set<string>; ordered: number; invoiced: number; pending: number; released: number }>()
  for (const l of lines) {
    const key = `${l.customer_name}\u0000${l.unit}`
    const cur = map.get(key) ?? { customer: l.customer_name, unit: l.unit, orders: new Set<string>(), ordered: 0, invoiced: 0, pending: 0, released: 0 }
    cur.orders.add(l.sales_order_id)
    cur.ordered += n(l.ordered); cur.invoiced += n(l.invoiced); cur.pending += n(l.pending); cur.released += n(l.released)
    map.set(key, cur)
  }
  return [...map.values()].map((c) => ({ ...c, orders: c.orders.size })).sort((a, b) => b.pending - a.pending || a.customer.localeCompare(b.customer))
}

export function customerPendingSheet(lines: TrackingLine[]): Sheet {
  return [
    ['Customer', 'Unit', 'Sales Orders', 'Ordered Qty', 'Invoiced Qty', 'Pending Invoice Qty', 'Released Qty'],
    ...customerPending(lines).map((c) => [c.customer, c.unit, c.orders, c.ordered, c.invoiced, c.pending, c.released]),
  ]
}
