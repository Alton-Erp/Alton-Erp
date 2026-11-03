// Stock register (by product) helpers: indicators, sorting and Excel layouts.
// Pure TypeScript so it can be unit-tested with Node directly.

export interface PositionLike {
  sku: string
  product_name: string
  category_name: string | null
  unit: string
  on_hand: number
  reserved: number
  available: number
  pending_po_quantity: number
  open_po_count: number
  pending_production_quantity: number
  expected_incoming_quantity: number
  bom_required_quantity: number
  bom_shortage_quantity: number
  ledger_on_hand: number
  discrepancy: boolean
  low_stock: boolean
  stock_status: string | null
}

export type Indicator = 'LOW' | 'SHORTAGE' | 'PENDING_PO' | 'DISCREPANCY'
export const INDICATOR_LABELS: Record<Indicator, string> = {
  LOW: 'Low available stock',
  SHORTAGE: 'BOM shortage',
  PENDING_PO: 'Pending purchase order',
  DISCREPANCY: 'Stock discrepancy (balance ≠ ledger)',
}

export function indicators(r: PositionLike): Indicator[] {
  const out: Indicator[] = []
  if (r.low_stock) out.push('LOW')
  if (Number(r.bom_shortage_quantity) > 0) out.push('SHORTAGE')
  if (Number(r.pending_po_quantity) > 0) out.push('PENDING_PO')
  if (r.discrepancy) out.push('DISCREPANCY')
  return out
}

export type PositionSortKey = 'sku' | 'product_name' | 'on_hand' | 'reserved' | 'available' | 'pending_po_quantity' | 'expected_incoming_quantity'
  | 'bom_required_quantity' | 'bom_shortage_quantity'

export function sortPositions<T extends PositionLike>(rows: T[], key: PositionSortKey, ascending: boolean): T[] {
  const dir = ascending ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[key]
    const y = b[key]
    const c = typeof x === 'number' || typeof y === 'number' ? Number(x) - Number(y) : String(x).localeCompare(String(y))
    return c === 0 ? a.sku.localeCompare(b.sku) : c * dir
  })
}

/** Excel rows (header first). Quantities stay numbers. */
export function stockPositionSheet(rows: PositionLike[]): (string | number | null)[][] {
  return [
    ['SKU', 'Product', 'Category', 'Unit', 'On hand', 'Reserved', 'Available', 'Pending PO', 'Open POs', 'Pending production', 'Expected incoming',
      'BOM required', 'BOM shortage', 'Ledger on hand', 'Discrepancy', 'Low stock', 'Stock status'],
    ...rows.map((r) => [r.sku, r.product_name, r.category_name, r.unit, Number(r.on_hand), Number(r.reserved), Number(r.available),
      Number(r.pending_po_quantity), Number(r.open_po_count), Number(r.pending_production_quantity), Number(r.expected_incoming_quantity),
      Number(r.bom_required_quantity), Number(r.bom_shortage_quantity), Number(r.ledger_on_hand), r.discrepancy ? 'Yes' : 'No', r.low_stock ? 'Yes' : 'No',
      r.stock_status]),
  ]
}

export const PROBLEM_LABELS: Record<string, string> = {
  LEDGER_WITHOUT_BALANCE: 'Ledger stock without a balance row',
  BALANCE_DIFFERS_FROM_LEDGER: 'Balance differs from the stock ledger',
  RESERVED_DIFFERS_FROM_RESERVATIONS: 'Reserved differs from active reservations',
  NEGATIVE_STOCK: 'Negative stock',
  OVER_RESERVED: 'Reserved more than on hand',
}

export function reconciliationSheet(rows: { sku: string; product_name: string; unit: string; warehouse_code: string | null; location_code: string | null
  batch_number: string | null; on_hand: number | null; ledger_on_hand: number; difference: number; reserved: number | null; active_reservations: number; problems: string[] }[]) {
  return [
    ['SKU', 'Product', 'Unit', 'Warehouse', 'Location', 'Batch', 'Balance on hand', 'Ledger on hand', 'Difference', 'Reserved', 'Active reservations', 'Problems'],
    ...rows.map((r) => [r.sku, r.product_name, r.unit, r.warehouse_code, r.location_code, r.batch_number, r.on_hand === null ? null : Number(r.on_hand),
      Number(r.ledger_on_hand), Number(r.difference), r.reserved === null ? null : Number(r.reserved), Number(r.active_reservations),
      r.problems.map((p) => PROBLEM_LABELS[p] ?? p).join('; ')]),
  ]
}
