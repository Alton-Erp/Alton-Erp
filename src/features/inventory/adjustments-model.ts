// Stock Adjustments: pure rules for the screen (unit-tested in tests/unit).
// Adjustment quantity = physical count − system stock. The database records both and posts the
// difference on approval (inventory_review_adjustment); nothing here changes stock.

/** Fixed reason category stored with every adjustment (inventory_adjustments.reason_code). */
export type ReasonCode = 'DAMAGE' | 'LOSS' | 'THEFT' | 'FOUND' | 'COUNT_VARIANCE' | 'EXPIRED' | 'DATA_CORRECTION' | 'OTHER'

/**
 * Category of a reason configured in ERP Settings (e.g. "Damaged" → DAMAGE). The user can change it;
 * this only pre-selects the most likely one. Unknown wording → OTHER.
 */
export function reasonCategory(label: string | null | undefined): ReasonCode {
  const l = (label ?? '').toLowerCase()
  if (/damag|break|broken|crack/.test(l)) return 'DAMAGE'
  if (/theft|stolen|pilfer/.test(l)) return 'THEFT'
  if (/expir|shelf life|write.?off/.test(l)) return 'EXPIRED'
  if (/found|surplus|excess/.test(l)) return 'FOUND'
  if (/count|variance|recount|physical/.test(l)) return 'COUNT_VARIANCE'
  if (/lost|loss|missing|short/.test(l)) return 'LOSS'
  if (/correct|entry|mistake|error|data/.test(l)) return 'DATA_CORRECTION'
  return 'OTHER'
}

/** Adjustment quantity = physical count − system stock (null until both are known). */
export function adjustmentDifference(systemQty: number | null | undefined, counted: number | null | undefined): number | null {
  if (systemQty === null || systemQty === undefined || counted === null || counted === undefined || Number.isNaN(counted)) return null
  return Math.round((counted - systemQty) * 1000) / 1000
}

export interface AdjustmentFilters {
  from: string | null
  to: string | null
  productId: string | null
  warehouseId: string | null
  reason: string | null
  type: 'QUANTITY' | 'SOURCE_CORRECTION' | null
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED' | null
}

export const EMPTY_ADJUSTMENT_FILTERS: AdjustmentFilters = { from: null, to: null, productId: null, warehouseId: null, reason: null, type: null, status: null }

interface TotalsRow {
  status: string
  adjustment_type: string
  difference: number | string | null
}

/**
 * Report totals: posted increases and decreases (quantity adjustments), pending approvals and completed
 * (posted) adjustments of the filtered list.
 */
export function adjustmentTotals(rows: TotalsRow[]) {
  const posted = rows.filter((r) => r.status === 'POSTED')
  const qty = posted.filter((r) => r.adjustment_type === 'QUANTITY')
  return {
    positive: qty.filter((r) => Number(r.difference) > 0).length,
    negative: qty.filter((r) => Number(r.difference) < 0).length,
    pending: rows.filter((r) => r.status === 'PENDING_APPROVAL').length,
    completed: posted.length,
  }
}
