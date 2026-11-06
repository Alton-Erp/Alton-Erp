import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from 'lucide-react'
import { Link } from 'react-router-dom'

import { formatCost } from '@/features/products/product-list-format'
import { CHANGE_LABELS, percentText, signedMoney, type ChangeType, type ProductPurchaseCost, type Trend } from '@/features/products/purchase-cost'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Arrow + signed percentage; the arrow, sign and label carry the meaning (never colour alone). */
export function CostTrend({ trend, percent, className }: { trend: Trend; percent: number | null; className?: string }) {
  if (trend === 'none') return null
  const Icon = trend === 'up' ? ArrowUpRight : trend === 'down' ? ArrowDownRight : ArrowRight
  const label = trend === 'up' ? 'Increase' : trend === 'down' ? 'Decrease' : 'No change'
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs tabular-nums',
      trend === 'up' ? 'text-shortage' : trend === 'down' ? 'text-available' : 'text-muted-foreground', className)}
      data-trend={trend} title={label}>
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{label} </span>
      {percent === null ? (trend === 'same' ? 'Same' : '') : percentText(percent)}
    </span>
  )
}

const TYPE_TREND: Record<ChangeType, Trend> = { INCREASE: 'up', DECREASE: 'down', NO_CHANGE: 'same', INITIAL_COST: 'none', NO_COST: 'none' }

/** Change badge for a change type (Initial cost and No valid receipt have no arrow). */
export function ChangeBadge({ type, percent, difference }: { type: ChangeType | null; percent: number | null; difference?: number | null }) {
  if (!type) return <span className="text-muted-foreground">—</span>
  const trend = TYPE_TREND[type]
  return (
    <span className="inline-flex flex-col items-end" data-change={type}>
      {trend === 'none'
        ? <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"><Minus aria-hidden className="size-3" />{CHANGE_LABELS[type]}</span>
        : <CostTrend trend={trend} percent={percent} />}
      {difference !== undefined && difference !== null && trend !== 'none' && trend !== 'same' && (
        <span className="text-[11px] tabular-nums text-muted-foreground">{signedMoney(difference, formatCost)}</span>
      )}
    </span>
  )
}

const historyLink = (productId: string) => `/products/${productId}?tab=purchase-cost`

/** Product Master: Last Purchase Cost, opening the product's Purchase Cost History. */
export function LastPurchaseCostCell({ productId, cost }: { productId: string; cost: ProductPurchaseCost | undefined }) {
  if (!cost || cost.last_cost === null) return <span className="text-muted-foreground" data-testid="last-cost">—</span>
  return (
    <Link to={historyLink(productId)} className="font-medium tabular-nums text-foreground hover:underline" data-testid="last-cost" title="Open the purchase cost history">
      {formatCost(cost.last_cost)}
    </Link>
  )
}

export function LastPurchaseDateCell({ cost }: { cost: ProductPurchaseCost | undefined }) {
  return <span className="whitespace-nowrap tabular-nums text-muted-foreground">{cost?.last_date ? formatDate(cost.last_date) : '—'}</span>
}

export function CostChangeCell({ productId, cost }: { productId: string; cost: ProductPurchaseCost | undefined }) {
  if (!cost?.change_type) return <span className="text-muted-foreground">—</span>
  return (
    <Link to={historyLink(productId)} className="hover:underline" data-testid="cost-change">
      <ChangeBadge type={cost.change_type} percent={cost.change_percent} difference={cost.difference} />
    </Link>
  )
}
