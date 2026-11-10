// Product Master Cost (migration 20261128090000): the cost of the second-most-recent valid purchase
// receipt; with fewer than two receipts, the product's standard (manufacturing) cost. The database
// calculates it in the view product_master_list; these helpers only read and present it.

export interface ProductMasterCostFields {
  master_cost: number | null
  /** PURCHASE = second-most-recent receipt; STANDARD = fallback (fewer than two receipts). */
  master_cost_source: 'PURCHASE' | 'STANDARD' | null
  master_cost_receipt_number: string | null
  master_cost_receipt_date: string | null
  /** The entered standard cost used as the fallback. */
  fallback_cost: number | null
  last_purchase_cost: number | null
  last_purchase_date: string | null
  master_cost_change: number | null
  master_cost_change_percent: number | null
}

interface CostSource {
  standard_cost: number | null
  standard_manufacturing_cost?: number | null
}

export interface MasterCost {
  cost: number | null
  source: 'PURCHASE' | 'STANDARD' | null
  receiptNumber: string | null
  receiptDate: string | null
  fallback: number | null
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * The Cost to show. From the view when the row has its columns; otherwise (database without the
 * view) the standard cost, by the same fallback rule: manufacturing cost, else the purchase cost.
 */
export function masterCost(p: CostSource & Partial<ProductMasterCostFields>): MasterCost {
  const fallback = 'fallback_cost' in p ? num(p.fallback_cost) : num(p.standard_manufacturing_cost) ?? num(p.standard_cost)
  if ('master_cost' in p) {
    return { cost: num(p.master_cost), source: p.master_cost_source ?? null, receiptNumber: p.master_cost_receipt_number ?? null,
      receiptDate: p.master_cost_receipt_date ?? null, fallback }
  }
  return { cost: fallback, source: fallback === null ? null : 'STANDARD', receiptNumber: null, receiptDate: null, fallback }
}

/** Cost Change = Last Purchase Cost − Cost (null when either is missing). */
export function costChange(last: number | null | undefined, cost: number | null | undefined): { difference: number; percent: number | null; trend: 'up' | 'down' | 'same' } | null {
  const l = num(last)
  const c = num(cost)
  if (l === null || c === null) return null
  const difference = Math.round((l - c) * 10000) / 10000
  const percent = c > 0 ? Math.round(((l - c) / c) * 10000) / 100 : null
  return { difference, percent, trend: difference > 0 ? 'up' : difference < 0 ? 'down' : 'same' }
}

/** Tooltip of the Cost cell: where the value comes from. */
export function masterCostNote(m: MasterCost, formatDate: (d: string) => string): string {
  if (m.source === 'PURCHASE') {
    return `Second-most-recent purchase receipt${m.receiptNumber ? ` ${m.receiptNumber}` : ''}${m.receiptDate ? ` (${formatDate(m.receiptDate)})` : ''}`
  }
  if (m.source === 'STANDARD') return 'Standard Manufacturing Cost (used until the product has two valid purchase receipts)'
  return 'No cost: no standard cost and fewer than two purchase receipts'
}
