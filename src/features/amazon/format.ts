import type { CampaignAnalysis } from './analysis.ts'
import type { Num } from './metrics.ts'

export const money = (v: Num | undefined, exact = false) =>
  v === null || v === undefined ? null : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: exact ? 2 : 0 }).format(v)
export const num = (v: Num | undefined, dp = 0) => (v === null || v === undefined ? null : v.toLocaleString('en-IN', { maximumFractionDigits: dp }))
export const pctText = (v: Num | undefined, dp = 1) => (v === null || v === undefined ? null : `${v.toLocaleString('en-IN', { maximumFractionDigits: dp })}%`)

export const CONFIDENCE_TONE = { HIGH: 'success', MEDIUM: 'info', LOW: 'neutral' } as const
export const STOCK_LABEL = { STOCKOUT_RISK: ['Stockout risk', 'danger'], LOW: ['Low', 'warning'], OK: ['OK', 'success'], OVERSTOCK: ['Overstock', 'outsourced'], UNKNOWN: ['Unknown', 'neutral'] } as const
export const PROFIT_LABEL = { PROFITABLE: ['Profitable', 'success'], BELOW_TARGET: ['Below target', 'warning'], LOSS: ['Loss after ads', 'danger'], UNKNOWN: ['Costs incomplete', 'neutral'] } as const
/** Plain-language assessment of a campaign against its products' break-even and target ACoS. */
export function campaignHealth(c: CampaignAnalysis): [string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'] {
  if (c.row.clicks > 0 && c.row.orders === 0) return ['Clicks, no orders', 'danger']
  if (c.acos === null) return ['No sales data', 'neutral']
  if (c.breakEvenAcos === null) return ['Costs incomplete', 'neutral']
  if (c.acos > c.breakEvenAcos) return ['Above break-even', 'danger']
  if (c.targetAcos !== null && c.acos > c.targetAcos) return ['Above target', 'warning']
  if ((c.constrainedShare ?? 0) >= 30) return ['Profitable, budget-limited', 'info']
  return ['Within target', 'success']
}
