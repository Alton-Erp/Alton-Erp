// BOM list cost columns (migration 20261208090000, view bom_cost_list): BOM Cost / Unit, Product Master Cost,
// Cost Difference and Cost Updated. The database stores the cost of approved BOM versions with the BOM pages'
// own formula (bomCost in bom-tools-model.ts); these helpers only present it. No cost is calculated here.

import { formatCost } from '../products/product-list-format.ts'

export interface BomCostRow {
  bom_id: string
  status: string
  /** Approved version with every component costed; null otherwise (shown as a dash). */
  bom_unit_cost: number | string | null
  bom_cost_status: 'COMPLETE' | 'MISSING_COSTS' | 'NO_COMPONENTS' | 'NOT_APPROVED' | 'NOT_CALCULATED' | string
  missing_count: number | null
  line_count: number | null
  cost_calculated_at: string | null
  product_master_cost: number | string | null
  product_master_cost_source: string | null
  cost_difference: number | string | null
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const round2 = (v: number) => Math.round(v * 100) / 100

export const BOM_COST_TOOLTIPS = {
  unit: 'Manufacturing cost of one finished unit from the approved BOM: Σ quantity × (1 + wastage %) × component Product Master Cost ÷ output quantity. A dash when the BOM is not approved, not yet calculated, or a component has no cost.',
  master: 'The cost currently stored in Product Master for the finished product (from its BOM, its latest valid GRN, a manual override or the entered standard cost).',
  difference: 'BOM Cost / Unit − Product Master Cost. Positive: the BOM costs more than the Product Master Cost.',
  updated: 'Date and time of the last successful BOM cost calculation (on approval / activation, a component cost change or Recalculate).',
} as const

/** Why there is no BOM cost (tooltip of the dash). */
export function bomCostMissingNote(c: BomCostRow | undefined): string {
  if (!c) return 'No cost information (Product Cost Intelligence is not installed).'
  switch (c.bom_cost_status) {
    case 'NOT_APPROVED': return 'Not an approved BOM: draft, pending and archived versions are never used as the manufacturing cost.'
    case 'NOT_CALCULATED': return 'Not calculated yet: use Recalculate costs.'
    case 'MISSING_COSTS': return `${c.missing_count ?? 'Some'} component(s) have no Product Master Cost.`
    case 'NO_COMPONENTS': return 'The BOM has no components.'
    default: return ''
  }
}

export const bomUnitCost = (c: BomCostRow | undefined) => num(c?.bom_unit_cost)
export const bomMasterCost = (c: BomCostRow | undefined) => num(c?.product_master_cost)
export const bomCostDifference = (c: BomCostRow | undefined): number | null => {
  const d = num(c?.cost_difference)
  return d === null ? null : round2(d)
}

/** INR with two decimals; "—" when there is no value. */
export const bomCostText = (v: number | null) => formatCost(v)
export const signedCostText = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${formatCost(v)}`)

/** Sort key: rows without a value go last in ascending order. */
export const costSortValue = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v)

export const BOM_COST_EXPORT_HEADERS = ['BOM Code', 'Version', 'Finished Product SKU', 'Product Name', 'BOM Status',
  'BOM Cost / Unit (INR)', 'Product Master Cost (INR)', 'Cost Difference (INR)', 'Cost Updated', 'Cost Note'] as const

/** "BOM Costs" sheet of the BOM Excel export: one row per BOM, the same values as the list (blank = dash). */
export function bomCostExportRows(
  boms: { id: string; bom_code: string; version: number; sku: string; product_name: string; status: string }[],
  costs: Map<string, BomCostRow>,
  formatWhen: (iso: string) => string = (iso) => iso,
): (string | number)[][] {
  const rows: (string | number)[][] = [[...BOM_COST_EXPORT_HEADERS]]
  for (const b of boms) {
    const c = costs.get(b.id)
    const unit = bomUnitCost(c)
    const master = bomMasterCost(c)
    const diff = bomCostDifference(c)
    rows.push([b.bom_code, b.version, b.sku, b.product_name, b.status,
      unit === null ? '' : round2(unit), master === null ? '' : round2(master), diff === null ? '' : diff,
      unit !== null && c?.cost_calculated_at ? formatWhen(c.cost_calculated_at) : '', unit === null ? bomCostMissingNote(c) : ''])
  }
  return rows
}
