// Labels and export layout of the day-based reorder plan. Pure TypeScript so it
// can be unit-tested with Node directly.

export type ReorderStatus = 'REORDER' | 'OK' | 'NO_CONSUMPTION' | 'NOT_CONFIGURED'

export const REORDER_STATUS_LABELS: Record<ReorderStatus, string> = {
  REORDER: 'Reorder now',
  OK: 'Enough cover',
  NO_CONSUMPTION: 'No consumption',
  NOT_CONFIGURED: 'No reorder level (days)',
}

export interface ReorderSheetRow {
  sku: string
  product_name: string
  unit: string
  status: ReorderStatus
  on_hand: number
  reserved: number
  available: number
  incoming: number
  consumed: number
  observed_days: number
  avg_daily: number | null
  coverage_days: number | null
  coverage_with_incoming_days: number | null
  reorder_level_days: number | null
  lead_time_days: number | null
  suggested_quantity: number | null
  legacy_reorder_quantity: number | null
}

/** Excel rows (header first); quantities stay numbers, missing values stay empty. */
export function reorderPlanSheet(rows: ReorderSheetRow[]): (string | number | null)[][] {
  return [
    ['SKU', 'Product', 'Unit', 'Status', 'On hand', 'Reserved', 'Available', 'Incoming (open POs)', 'Consumed', 'Days observed', 'Average per day',
      'Days of cover', 'Days of cover incl. incoming', 'Reorder level (days)', 'Lead time (days)', 'Suggested order quantity', 'Earlier reorder quantity'],
    ...rows.map((r) => [r.sku, r.product_name, r.unit, REORDER_STATUS_LABELS[r.status], Number(r.on_hand), Number(r.reserved), Number(r.available),
      Number(r.incoming), Number(r.consumed), r.observed_days, num(r.avg_daily), num(r.coverage_days), num(r.coverage_with_incoming_days),
      num(r.reorder_level_days), num(r.lead_time_days), num(r.suggested_quantity), num(r.legacy_reorder_quantity)]),
  ]
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v))
