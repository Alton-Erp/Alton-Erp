// Purchase Cost Intelligence (migration 20261123090000): types and pure helpers, unit-tested in tests/unit.
// The Last Purchase Cost is kept apart from Standard Purchase / Manufacturing Cost, MRP, Selling Price and the
// average inventory cost; it is set only by posted goods receipts (or an authorised manual override).

export type ChangeType = 'INCREASE' | 'DECREASE' | 'NO_CHANGE' | 'INITIAL_COST' | 'NO_COST'
export type PurchaseCostEventType = 'GRN_RECEIPT' | 'GRN_REVERSAL' | 'MANUAL_OVERRIDE'
export type ZeroCostPolicy = 'IGNORE' | 'APPLY' | 'INITIAL_ONLY'
export type OverridePermission = 'purchase_exception.approve' | 'purchase_order.approve' | 'products.update' | 'settings.manage'

/** Current Last Purchase Cost of a product (public.product_purchase_costs). */
export interface ProductPurchaseCost {
  product_id: string
  last_cost: number | null
  last_date: string | null
  previous_cost: number | null
  difference: number | null
  change_percent: number | null
  change_type: ChangeType | null
  supplier_name: string | null
  /** Asked with a supplier: that supplier's latest valid receipt cost. */
  supplier_last_cost: number | null
  supplier_last_date: string | null
  /** Significant change threshold (%), from ERP Settings. */
  threshold: number
}

export interface PurchaseCostEvent {
  id: string
  event_type: PurchaseCostEventType
  status: 'APPLIED' | 'NOT_APPLIED'
  not_applied_reason: string | null
  previous_cost: number | null
  new_cost: number | null
  difference: number | null
  change_percent: number | null
  change_type: ChangeType
  significant: boolean
  received_quantity: number | null
  rejected_quantity: number | null
  unit: string | null
  currency: string
  cost_basis: Record<string, unknown>
  supplier_id: string | null
  supplier_name: string | null
  purchase_order_id: string | null
  po_number: string | null
  goods_receipt_id: string | null
  receipt_number: string | null
  effective_date: string
  posted_at: string
  reason: string
  created_at: string
  reversed: boolean
  created_by_name: string | null
}

export interface PurchaseCostSettings {
  auto_update: boolean
  increase_alerts: boolean
  decrease_alerts: boolean
  alert_percent: number
  zero_policy: ZeroCostPolicy
  override_permission: OverridePermission
  trigger: 'GRN_POSTING'
  history: true
}

export interface PurchaseCostHistory {
  product: { id: string; sku: string; product_name: string; base_unit: string; standard_cost: number | null
    standard_manufacturing_cost: number | null; mrp: number | null; selling_price: number | null }
  current: { cost: number | null; date: string | null; previous_cost: number | null; difference: number | null; change_percent: number | null
    change_type: ChangeType | null; supplier_name: string | null; source_event_id: string | null } | null
  average_inventory_cost: number | null
  settings: PurchaseCostSettings
  can_override: boolean
  events: PurchaseCostEvent[]
}

export const CHANGE_LABELS: Record<ChangeType, string> = {
  INCREASE: 'Increase',
  DECREASE: 'Decrease',
  NO_CHANGE: 'No change',
  INITIAL_COST: 'Initial cost',
  NO_COST: 'No valid receipt',
}
export const EVENT_LABELS: Record<PurchaseCostEventType, string> = {
  GRN_RECEIPT: 'Posted',
  GRN_REVERSAL: 'Reversal',
  MANUAL_OVERRIDE: 'Manual override',
}
export const ZERO_POLICY_LABELS: Record<ZeroCostPolicy, string> = {
  IGNORE: 'Ignore zero-cost receipts (recommended)',
  INITIAL_ONLY: 'Use zero only when the product has no cost yet',
  APPLY: 'Apply zero like any other cost',
}
export const OVERRIDE_LABELS: Record<OverridePermission, string> = {
  'purchase_exception.approve': 'Purchase exception approvers (recommended)',
  'purchase_order.approve': 'Purchase order approvers',
  'products.update': 'Users who can edit the Product Master',
  'settings.manage': 'Users who can manage ERP settings',
}

export type Trend = 'up' | 'down' | 'same' | 'none'

/** Direction of a change: up (dearer), down (cheaper), same, or none (no earlier cost to compare). */
export function trendOf(previous: number | null | undefined, next: number | null | undefined): Trend {
  if (previous === null || previous === undefined || next === null || next === undefined) return 'none'
  const d = round4(Number(next) - Number(previous))
  return d > 0 ? 'up' : d < 0 ? 'down' : 'same'
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** Same classification as the database (product_purchase_cost_events.change_type). */
export function changeTypeOf(previous: number | null | undefined, next: number | null | undefined): ChangeType {
  if (next === null || next === undefined) return 'NO_COST'
  if (previous === null || previous === undefined) return 'INITIAL_COST'
  const t = trendOf(previous, next)
  return t === 'up' ? 'INCREASE' : t === 'down' ? 'DECREASE' : 'NO_CHANGE'
}

/** Difference and percentage between an earlier cost and a new one (percentage null without an earlier cost above 0). */
export function costChange(previous: number | null | undefined, next: number | null | undefined) {
  const trend = trendOf(previous, next)
  if (trend === 'none') return { trend, difference: null, percent: null }
  const difference = round4(Number(next) - Number(previous))
  const percent = Number(previous) > 0 ? Math.round((difference / Number(previous)) * 10000) / 100 : null
  return { trend, difference, percent }
}

/** A PO price far enough from the current cost to warn about (|%| at or above the threshold). */
export function isSignificant(percent: number | null | undefined, threshold: number | null | undefined): boolean {
  if (percent === null || percent === undefined || threshold === null || threshold === undefined) return false
  return Math.abs(Number(percent)) >= Number(threshold) && Number(percent) !== 0
}

/** "+8.24%", "−2.17%", "0%" (true minus sign), or '' without a percentage. */
export function percentText(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return ''
  const n = Number(percent)
  if (n === 0) return '0%'
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`
}

/** Signed amount using the given money formatter: "+₹70.00", "−₹20.00", "₹0.00". */
export function signedMoney(amount: number | null | undefined, money: (n: number) => string): string {
  if (amount === null || amount === undefined) return ''
  const n = Number(amount)
  if (n === 0) return money(0)
  return `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`
}

/**
 * Net unit cost of a PO line as the goods receipt will value it: round((quantity × price − line discount) ÷ quantity, 4),
 * excluding GST and charge lines — the same rule as the database (order line taxable value ÷ ordered quantity).
 */
export function poLineNetUnitCost(line: { quantity: number | null; unit_price: number | null; discount_percent?: number | null; discount_amount?: number | null }): number | null {
  const q = Number(line.quantity)
  const p = line.unit_price === null || line.unit_price === undefined ? NaN : Number(line.unit_price)
  if (!(q > 0) || !Number.isFinite(p) || p < 0) return null
  const gross = Math.round(q * p * 100) / 100
  const pct = Number(line.discount_percent ?? 0)
  const amount = Number(line.discount_amount ?? 0)
  const discount = Math.min(pct > 0 ? Math.round(((gross * pct) / 100) * 100) / 100 : amount > 0 ? amount : 0, gross)
  return round4((gross - discount) / q)
}

/** Quantity-weighted unit cost of several receipt lines of one product (as the database records it). */
export function weightedUnitCost(lines: { accepted_quantity: number; unit_cost: number | null }[]): number | null {
  const counted = lines.filter((l) => Number(l.accepted_quantity) > 0)
  if (counted.length === 0 || counted.some((l) => l.unit_cost === null)) return null
  const qty = counted.reduce((s, l) => s + Number(l.accepted_quantity), 0)
  return round4(counted.reduce((s, l) => s + Number(l.accepted_quantity) * Number(l.unit_cost), 0) / qty)
}

/** The price trend: the Last Purchase Cost after each applied event, oldest first (a cleared cost is left out). */
export function trendPoints(events: PurchaseCostEvent[], label: (e: PurchaseCostEvent) => string): { label: string; value: number }[] {
  return [...events]
    .filter((e) => e.status === 'APPLIED' && e.new_cost !== null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((e) => ({ label: label(e), value: Number(e.new_cost) }))
}

export interface HistoryFilter {
  from: string
  to: string
  supplierId: string
  change: 'all' | 'increase' | 'decrease'
}
export const EMPTY_FILTER: HistoryFilter = { from: '', to: '', supplierId: '', change: 'all' }

/** History rows matching the date range (effective date), supplier and increase / decrease filters. */
export function filterHistory(events: PurchaseCostEvent[], f: HistoryFilter): PurchaseCostEvent[] {
  return events.filter((e) => (!f.from || e.effective_date >= f.from) && (!f.to || e.effective_date <= f.to)
    && (!f.supplierId || e.supplier_id === f.supplierId)
    && (f.change === 'all' || (f.change === 'increase' ? e.change_type === 'INCREASE' : e.change_type === 'DECREASE')))
}

/** Suppliers that appear in the history, for the filter (first name seen per id). */
export function historySuppliers(events: PurchaseCostEvent[]): { id: string; name: string }[] {
  const out = new Map<string, string>()
  for (const e of events) if (e.supplier_id && !out.has(e.supplier_id)) out.set(e.supplier_id, e.supplier_name ?? 'Supplier')
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}
