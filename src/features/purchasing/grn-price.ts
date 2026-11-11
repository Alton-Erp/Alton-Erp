// Actual purchase unit cost at GRN level: variance, cost, payable and report summaries.
//
// The server (purchase_receipt_post, migration 20261202090000) decides; these helpers repeat its rules for
// the receipt screen with exact decimal arithmetic (integers, rounding half away from zero like PostgreSQL
// numeric round), so the preview and the posted payable agree to the paise.

/** Suggested reasons for a price that differs from the PO. "Other" needs a description. */
export const PRICE_REASONS = [
  'Supplier price revision',
  'Market price increase',
  'Negotiated price change',
  'PO price entered incorrectly',
  'Other',
] as const

/** A change at or above this percentage (either way) is highlighted before posting. */
export const LARGE_PRICE_CHANGE_PERCENT = 20
/** Largest actual unit price accepted (the PO price column holds 12 digits before the decimal point). */
export const MAX_ACTUAL_PRICE = 999_999_999_999
/** Largest unit cost stock can be valued at (inventory cost columns are numeric(14,4)). */
export const MAX_STOCK_UNIT_COST = '9999999999.9999'
/** Largest line value that can be recorded (line_value is numeric(16,2)). */
const MAX_LINE_VALUE_PAISE = 9_999_999_999_999_999n

const PRICE = /^\d+(\.\d{1,4})?$/

// ---------------------------------------------------------------------------
// Exact decimals: a value v with s decimals is held as the integer v × 10^s.
// ---------------------------------------------------------------------------
const TEN = (s: number) => 10n ** BigInt(s)

/** Parses a decimal (number or string) into an integer with `scale` decimals; null when not a decimal. */
export function toScaled(v: number | string | null | undefined, scale: number): bigint | null {
  if (v === null || v === undefined) return null
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim()
  if (/e/i.test(s)) s = Number(s).toFixed(scale + 2)
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[3] ?? ''
  const kept = BigInt(m[2] + frac.slice(0, scale).padEnd(scale, '0'))
  // More decimals than the scale: round half away from zero.
  const rest = frac.slice(scale)
  const up = rest.length > 0 && rest[0] >= '5' ? 1n : 0n
  const abs = kept + up
  return m[1] === '-' ? -abs : abs
}

/** num / den rounded half away from zero (den > 0). */
function divRound(num: bigint, den: bigint): bigint {
  const neg = num < 0n
  const a = neg ? -num : num
  const q = (2n * a + den) / (2n * den)
  return neg ? -q : q
}

const fromScaled = (v: bigint, scale: number) => Number(v) / 10 ** scale

// ---------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------
export type PriceDirection = 'INCREASE' | 'DECREASE' | 'NONE'

export interface PriceVariance {
  /** Parsed actual price; null when the entry is not a valid price. */
  actual: number | null
  poPrice: number
  difference: number | null
  /** Difference / PO price × 100 (2 decimals); null when the PO price is zero. */
  percent: number | null
  direction: PriceDirection
  changed: boolean
  large: boolean
  error: string | null
}

/** Compares the actual price entered on the GRN with the PO price. Blank means "the PO price". */
export function priceVariance(poPrice: number | string | null | undefined, actualInput: string): PriceVariance {
  const po4 = toScaled(poPrice ?? 0, 4) ?? 0n
  const po = fromScaled(po4, 4)
  const text = actualInput.trim()
  const none = { poPrice: po, direction: 'NONE' as const, changed: false, large: false }
  if (text === '') return { ...none, actual: po, difference: 0, percent: po4 > 0n ? 0 : null, error: null }
  if (!PRICE.test(text)) {
    return { ...none, actual: null, difference: null, percent: null, error: 'Enter the actual purchase unit cost as a number (up to 4 decimals, not negative).' }
  }
  const a4 = toScaled(text, 4)!
  if (a4 > BigInt(MAX_ACTUAL_PRICE) * TEN(4)) {
    return { ...none, actual: null, difference: null, percent: null, error: 'The actual purchase unit cost is too large (the maximum is 999,999,999,999).' }
  }
  const diff4 = a4 - po4
  const changed = diff4 !== 0n
  const percent = po4 > 0n ? fromScaled(divRound(diff4 * 10_000n, po4), 2) : null
  return {
    actual: fromScaled(a4, 4), poPrice: po, difference: fromScaled(diff4, 4), percent, changed,
    direction: diff4 > 0n ? 'INCREASE' : diff4 < 0n ? 'DECREASE' : 'NONE',
    large: changed && (percent === null || Math.abs(percent) >= LARGE_PRICE_CHANGE_PERCENT),
    error: changed && a4 === 0n ? `The actual purchase unit cost cannot be zero when the PO price is ${po}.` : null,
  }
}

// ---------------------------------------------------------------------------
// Cost and payable (same formulas as purchase_receipt_post)
// ---------------------------------------------------------------------------
/** The order line fields the cost and payable come from (purchase_order_lines). */
export interface PricedLine {
  line_type?: string
  ordered_quantity: number | string
  unit_price: number | string | null
  discount_percent: number | string | null
  discount_amount: number | string
  taxable_value: number | string
  line_total: number | string
  /** Tax components set on the order line from its tax treatment (all zero for NO_GST / IMPORT orders). */
  cgst_rate: number | string
  sgst_rate: number | string
  igst_rate: number | string
}

export interface ReceiptPayable {
  changed: boolean
  /** Unit cost after discount, excl. GST (stock cost of the received goods). */
  cost: number
  /** PO unit cost after discount, excl. GST (snapshot). */
  poCost: number
  /** Accepted goods value excl. GST. */
  taxable: number
  cgst: number
  sgst: number
  igst: number
  /** Supplier payable incl. GST for the accepted quantity (goods_receipt_lines.line_value). */
  payable: number
  error: string | null
}

const num = (v: number | string | null | undefined, s: number) => toScaled(v ?? 0, s) ?? 0n

/** PO unit cost after discount, excl. GST: round(taxable_value / ordered_quantity, 4), in 1/10000. */
function poCost4(line: PricedLine): bigint {
  return divRound(num(line.taxable_value, 2) * 100_000n, num(line.ordered_quantity, 3))
}

/**
 * Cost and payable of one receipt line for an actual price and accepted quantity, exactly as the server
 * stores them. Unchanged price: the accepted share of the order line total. Changed price: actual price
 * less the order line's discount, then CGST, SGST and IGST at the order line's rates, each rounded.
 */
export function receiptPayable(line: PricedLine, actual: number | string, accepted: number | string): ReceiptPayable {
  const q3 = num(line.ordered_quantity, 3)
  const acc3 = num(accepted, 3)
  const a4 = num(actual, 4)
  const po4 = poCost4(line)
  const changed = a4 !== num(line.unit_price, 4)
  let cost4 = po4
  let error: string | null = null
  let taxable: bigint
  let cgst = 0n, sgst = 0n, igst = 0n, payable: bigint
  if (!changed) {
    taxable = divRound(acc3 * po4, 100_000n)
    payable = divRound(acc3 * num(line.line_total, 2), q3)
    // Display split only: the order line's own tax share.
    const tax = payable - taxable
    if (num(line.igst_rate, 2) > 0n) igst = tax
    else { cgst = divRound(tax, 2n); sgst = tax - cgst }
  } else {
    const pct2 = num(line.discount_percent, 2)
    cost4 = pct2 > 0n
      ? divRound(a4 * (10_000n - pct2), 10_000n)
      : divRound(a4 * q3 - num(line.discount_amount, 2) * 100_000n, q3)
    if (cost4 < 0n) error = 'The actual purchase unit cost is lower than the discount per unit on the order line.'
    else if (cost4 > num(MAX_STOCK_UNIT_COST, 4)) error = 'The cost after discount is larger than stock can be valued at (the maximum is 9,999,999,999.9999 per unit).'
    taxable = divRound(acc3 * cost4, 100_000n)
    cgst = divRound(taxable * num(line.cgst_rate, 3), 100_000n)
    sgst = divRound(taxable * num(line.sgst_rate, 3), 100_000n)
    igst = divRound(taxable * num(line.igst_rate, 3), 100_000n)
    payable = taxable + cgst + sgst + igst
  }
  if (!error && payable > MAX_LINE_VALUE_PAISE) error = 'The value of this line is too large to record. Check the quantity and the price.'
  return {
    changed, cost: fromScaled(cost4, 4), poCost: fromScaled(po4, 4), taxable: fromScaled(taxable, 2),
    cgst: fromScaled(cgst, 2), sgst: fromScaled(sgst, 2), igst: fromScaled(igst, 2), payable: fromScaled(payable, 2), error,
  }
}

/** The tax treatment the order line's rates express (for labels). */
export function taxLabel(line: Pick<PricedLine, 'cgst_rate' | 'sgst_rate' | 'igst_rate'>): string {
  const c = Number(line.cgst_rate), s = Number(line.sgst_rate), i = Number(line.igst_rate)
  if (i > 0) return `IGST ${i}%`
  if (c > 0 || s > 0) return `CGST ${c}% + SGST ${s}%`
  return 'No GST'
}

/** The text stored as the reason: the chosen reason, with the description when one is given ("Other" needs it). */
export function priceReasonText(reason: string, remark: string): string | null {
  const r = reason.trim()
  const m = remark.trim()
  if (!r) return null
  if (r === 'Other') return m ? `Other: ${m}` : null
  return m ? `${r}: ${m}` : r
}

/** Splits a stored reason back into the select value and the description (for corrections). */
export function splitPriceReason(stored: string | null | undefined): { reason: string; remark: string } {
  if (!stored) return { reason: '', remark: '' }
  for (const r of PRICE_REASONS) {
    if (stored === r) return { reason: r, remark: '' }
    if (stored.startsWith(`${r}: `)) return { reason: r, remark: stored.slice(r.length + 2) }
  }
  return { reason: 'Other', remark: stored }
}

/**
 * Problem with a line's price entry, or null when it can be posted. `line` and `accepted` add the cost
 * and value limits; without them only the price and reason are checked.
 */
export function priceProblem(poPrice: number | string | null | undefined, actualInput: string, reason: string, remark: string,
  line?: PricedLine, accepted?: string): string | null {
  const v = priceVariance(poPrice, actualInput)
  if (v.error) return v.error
  if (!v.changed) return null
  if (line?.line_type && line.line_type !== 'GOODS') return 'the actual purchase unit cost can only be changed on goods lines.'
  if (!reason.trim()) return 'select the reason for the price change.'
  if (reason === 'Other' && remark.trim().length < 3) return 'describe the reason for the price change (Other).'
  if (line && v.actual !== null) {
    const p = receiptPayable(line, actualInput.trim(), accepted ?? '0')
    if (p.error) return p.error
  }
  return null
}

const PRICE_FMT = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 4 })
/** A unit price: ₹ with 2 to 4 decimals. */
export const formatPrice = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : PRICE_FMT.format(Number(v)))

/** "+₹3.00" / "−₹2.00" / "₹0.00". */
export const formatSignedPrice = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${PRICE_FMT.format(Math.abs(v))}`)

/** "+25.00%" / "−5.00%". */
export const formatSignedPercent = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`)

export const directionLabel = (d: PriceDirection) => (d === 'INCREASE' ? 'Increase' : d === 'DECREASE' ? 'Decrease' : 'No change')

/** True when a posting result confirms the server recorded actual purchase costs. */
export const actualCostConfirmed = (result: { actual_cost_supported?: unknown } | null | undefined) => result?.actual_cost_supported === true

// ---------------------------------------------------------------------------
// Report summaries (goods_receipt_price_variance rows)
// ---------------------------------------------------------------------------
export interface VarianceRow {
  receipt_status: string
  receipt_date: string
  supplier_id: string
  supplier_name: string | null
  product_id: string | null
  sku: string | null
  description: string
  accepted_quantity: number | string
  /** False for GRNs posted before prices were recorded: no PO / actual price is shown for them. */
  price_recorded: boolean
  po_unit_price: number | string | null
  actual_unit_price: number | string | null
  price_difference: number | string | null
  accepted_value: number | string | null
  accepted_value_at_po: number | string | null
}

const counted = (r: VarianceRow) => r.receipt_status === 'POSTED' && r.price_recorded

/** Value effect of the price change on accepted goods (excl. GST): value at actual cost − value at PO cost. */
export const varianceValue = (r: VarianceRow) => (r.price_recorded ? Math.round((Number(r.accepted_value ?? 0) - Number(r.accepted_value_at_po ?? 0)) * 100) / 100 : 0)

export interface VarianceSummary { lines: number; notRecorded: number; changed: number; increases: number; decreases: number; totalVariance: number; valueAtPo: number; valueActual: number }

/** Totals over posted GRN lines with recorded prices (reversed GRNs and unrecorded lines are left out). */
export function summariseVariance(rows: VarianceRow[]): VarianceSummary {
  const recorded = rows.filter(counted)
  const changed = recorded.filter((r) => Number(r.price_difference ?? 0) !== 0)
  const sum = (f: (r: VarianceRow) => number) => Math.round(recorded.reduce((s, r) => s + f(r), 0) * 100) / 100
  return {
    lines: recorded.length,
    notRecorded: rows.filter((r) => r.receipt_status === 'POSTED' && !r.price_recorded).length,
    changed: changed.length,
    increases: changed.filter((r) => Number(r.price_difference) > 0).length,
    decreases: changed.filter((r) => Number(r.price_difference) < 0).length,
    totalVariance: sum(varianceValue),
    valueAtPo: sum((r) => Number(r.accepted_value_at_po ?? 0)),
    valueActual: sum((r) => Number(r.accepted_value ?? 0)),
  }
}

export interface SupplierVariance { supplierId: string; supplier: string; lines: number; increases: number; decreases: number; variance: number }

/** Supplier-wise price changes (posted GRNs with recorded prices), largest total increase first. */
export function varianceBySupplier(rows: VarianceRow[]): SupplierVariance[] {
  const map = new Map<string, SupplierVariance>()
  for (const r of rows) {
    if (!counted(r)) continue
    const s = map.get(r.supplier_id) ?? { supplierId: r.supplier_id, supplier: r.supplier_name ?? '—', lines: 0, increases: 0, decreases: 0, variance: 0 }
    const d = Number(r.price_difference ?? 0)
    s.lines += 1
    if (d > 0) s.increases += 1
    if (d < 0) s.decreases += 1
    s.variance = Math.round((s.variance + varianceValue(r)) * 100) / 100
    map.set(r.supplier_id, s)
  }
  return [...map.values()].sort((a, b) => b.variance - a.variance || a.supplier.localeCompare(b.supplier))
}

export interface ProductTrend { productId: string; sku: string; description: string; receipts: number; firstPrice: number; lastPrice: number; change: number; percent: number | null; variance: number }

/** Product-wise actual price trend over posted GRNs with recorded prices (first → latest in the period). */
export function productTrends(rows: VarianceRow[]): ProductTrend[] {
  const groups = new Map<string, VarianceRow[]>()
  for (const r of rows) {
    if (!counted(r) || !r.product_id) continue
    groups.set(r.product_id, [...(groups.get(r.product_id) ?? []), r])
  }
  return [...groups.entries()].map(([productId, list]) => {
    const sorted = [...list].sort((a, b) => a.receipt_date.localeCompare(b.receipt_date))
    const firstPrice = Number(sorted[0].actual_unit_price ?? 0)
    const lastPrice = Number(sorted.at(-1)!.actual_unit_price ?? 0)
    const change = Math.round((lastPrice - firstPrice) * 10_000) / 10_000
    return {
      productId, sku: sorted[0].sku ?? '', description: sorted[0].description, receipts: sorted.length, firstPrice, lastPrice, change,
      percent: firstPrice > 0 ? Math.round((change / firstPrice) * 10_000) / 100 : null,
      variance: Math.round(sorted.reduce((s, r) => s + varianceValue(r), 0) * 100) / 100,
    }
  }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.sku.localeCompare(b.sku))
}
