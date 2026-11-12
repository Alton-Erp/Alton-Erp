// Product Master Cost Intelligence (migration 20261208090000): how the stored costs are presented. The rules
// themselves (which cost becomes the Product Master Cost) run only in the database
// (private.product_cost_refresh); nothing here calculates a cost.

import type { MasterCostSource } from './master-cost.ts'
import type { SourceType } from './product-model.ts'

export interface CostIntelligenceFields {
  default_source_type: SourceType
  master_cost?: number | string | null
  master_cost_source?: MasterCostSource | null
  master_cost_reference?: string | null
  master_cost_receipt_number?: string | null
  master_cost_receipt_date?: string | null
  bom_manufacturing_cost?: number | string | null
  bom_cost_bom_code?: string | null
  bom_cost_version?: number | null
  bom_cost_status?: string | null
  bom_cost_at?: string | null
  last_purchase_cost?: number | string | null
  last_purchase_date?: string | null
  default_cost_source?: 'BOM' | 'GRN' | null
  cost_status?: string | null
  cost_status_note?: string | null
  cost_updated_at?: string | null
  updated_at?: string | null
}

/** Cost Source shown to the user: BOM / GRN / Manual (and which rule set an earlier cost). */
export const COST_SOURCE_LABELS: Record<MasterCostSource, string> = {
  BOM: 'BOM',
  GRN: 'GRN',
  MANUAL: 'Manual (purchase cost override)',
  PURCHASE: 'GRN (earlier rule: second-most-recent receipt)',
  STANDARD: 'Manual (entered standard cost)',
}

export const DEFAULT_COST_SOURCE_LABELS = { BOM: 'BOM Manufacturing Cost', GRN: 'Last Purchase Cost (GRN)' } as const

export const COST_EVENT_LABELS: Record<string, string> = {
  BOM_ACTIVATED: 'BOM approved and activated',
  BOM_DEACTIVATED: 'BOM no longer active',
  GRN_POSTED: 'GRN posted',
  GRN_REVERSED: 'GRN reversed',
  PURCHASE_OVERRIDE: 'Manual purchase cost override',
  COMPONENT_COST_CHANGED: 'Component cost changed',
  DEFAULT_SOURCE_CHANGED: 'Default cost source changed',
  SOURCING_CHANGED: 'Sourcing method changed',
  STANDARD_COST_CHANGED: 'Standard cost changed',
  RECALCULATED: 'Recalculated',
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export interface CostIntelligenceView {
  /** False before the migration (the view has none of the new columns). */
  available: boolean
  bomCost: number | null
  bomReference: string | null
  bomNote: string
  lastPurchaseCost: number | null
  lastPurchaseDate: string | null
  currentCost: number | null
  source: MasterCostSource | null
  sourceLabel: string
  reference: string | null
  /** Latest successful update of the current cost (or, for the entered standard cost, the product's last update). */
  lastUpdated: string | null
  status: { tone: 'ok' | 'info' | 'warning'; text: string }
  /** Both products only: the configured default (BOM unless set). */
  defaultCostSource: 'BOM' | 'GRN' | null
  /** Which cost the rules use for this sourcing method. */
  rule: string
}

export function costIntelligence(p: CostIntelligenceFields): CostIntelligenceView {
  const available = 'cost_status' in p
  const source = (p.master_cost_source ?? null) as MasterCostSource | null
  const bomCost = num(p.bom_manufacturing_cost)
  const bomReference = p.bom_cost_bom_code ? `${p.bom_cost_bom_code} v${p.bom_cost_version ?? ''}`.trim() : null
  const bomNote = bomCost !== null ? `Active approved BOM ${bomReference ?? ''}`.trim()
    : p.bom_cost_status === 'MISSING_COSTS' ? 'Active BOM: some components have no cost'
      : p.bom_cost_status === 'NO_COMPONENTS' ? 'Active BOM has no components'
        : 'No active approved BOM'
  const reference = source === 'GRN' ? (p.master_cost_reference ?? p.master_cost_receipt_number ?? null)
    : source === 'BOM' ? (p.master_cost_reference ?? null)
      : source === 'PURCHASE' ? (p.master_cost_receipt_number ?? null) : null
  const lastUpdated = p.cost_updated_at ?? (source === 'PURCHASE' ? (p.master_cost_receipt_date ?? null) : (p.updated_at ?? null))
  const statusCode = p.cost_status ?? 'NO_NEW_COST'
  const status: CostIntelligenceView['status'] = !available ? { tone: 'info', text: 'Cost Intelligence is not installed on this database yet.' }
    : statusCode === 'CURRENT' ? { tone: 'ok', text: 'Up to date' }
      : statusCode === 'CIRCULAR_DEPENDENCY' ? { tone: 'warning', text: p.cost_status_note ?? 'Recalculation stopped: circular BOM dependency.' }
        : statusCode === 'BOM_INCOMPLETE' ? { tone: 'warning', text: p.cost_status_note ?? 'No new cost available: the BOM cost is incomplete.' }
          : { tone: 'info', text: p.cost_status_note ?? 'No new cost available' }
  const method = p.default_source_type
  const defaultCostSource = method === 'HYBRID' ? (p.default_cost_source ?? 'BOM') : null
  const rule = method === 'IN_HOUSE' ? 'Manufacture: the cost of the active approved BOM.'
    : method === 'OUTSOURCED' ? 'Purchase: the latest valid posted GRN (GST excluded, after discount).'
      : `Both: BOM and purchase costs are kept separately; the default source (${DEFAULT_COST_SOURCE_LABELS[defaultCostSource ?? 'BOM']}) sets the Product Master Cost. Each stock receipt keeps its own actual cost.`
  return {
    available, bomCost, bomReference, bomNote,
    lastPurchaseCost: num(p.last_purchase_cost), lastPurchaseDate: p.last_purchase_date ?? null,
    currentCost: num(p.master_cost), source, sourceLabel: source ? COST_SOURCE_LABELS[source] : 'No cost',
    reference, lastUpdated, status, defaultCostSource, rule,
  }
}

/** One line of the cost history: "₹999.00 → ₹48.90". */
export function historyChange(prev: number | string | null, next: number | string, money: (v: number) => string): string {
  const a = num(prev)
  const b = num(next) ?? 0
  return a === null ? money(b) : `${money(a)} → ${money(b)}`
}

/** Related BOM version or GRN of a history row. */
export function historyReference(r: { new_source: string; bom_code: string | null; bom_version: number | null; receipt_number: string | null }): string {
  if (r.new_source === 'BOM' && r.bom_code) return `${r.bom_code} v${r.bom_version ?? ''}`
  if (r.new_source === 'GRN' && r.receipt_number) return r.receipt_number
  if (r.new_source === 'MANUAL') return 'Manual override'
  return '—'
}
