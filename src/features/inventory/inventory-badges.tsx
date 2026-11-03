import { AlertTriangle, Factory, HelpCircle, Truck } from 'lucide-react'

import { StatusBadge } from '@/components/common/status-badge'
import type { Tone } from '@/config/status'
import {
  ALERT_TYPE_LABELS,
  APPROVAL_STATUS_LABELS,
  RESERVATION_STATUS_LABELS,
  STOCK_SOURCE_LABELS,
  STOCK_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  type StockSourceCode,
} from '@/features/inventory/inventory-model'
import { cn } from '@/lib/utils'

const SOURCE_STYLE: Record<StockSourceCode, { icon: typeof Factory; className: string }> = {
  IN_HOUSE: { icon: Factory, className: 'bg-blue-50 text-blue-700 border-blue-200' },
  OUTSOURCED: { icon: Truck, className: 'bg-violet-50 text-violet-700 border-violet-200' },
  UNKNOWN: { icon: HelpCircle, className: 'bg-amber-50 text-amber-800 border-amber-200' },
}

/** Actual source of stock (per lot), as opposed to a product's default source type. */
export function StockSourceBadge({ source, className }: { source: string; className?: string }) {
  const style = SOURCE_STYLE[source as StockSourceCode] ?? SOURCE_STYLE.UNKNOWN
  const Icon = style.icon
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium', style.className, className)}>
      <Icon aria-hidden className="size-3" />
      {STOCK_SOURCE_LABELS[source as StockSourceCode] ?? source}
    </span>
  )
}

const STOCK_STATUS_TONE: Record<string, Tone> = {
  HEALTHY: 'success',
  LOW_STOCK: 'warning',
  OUT_OF_STOCK: 'danger',
  FULLY_RESERVED: 'danger',
  NO_THRESHOLD: 'neutral',
}

export function StockStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={STOCK_STATUS_LABELS[status] ?? status} tone={STOCK_STATUS_TONE[status] ?? 'neutral'} />
}

export function TransactionTypeBadge({ type, direction }: { type: string; direction: number }) {
  return <StatusBadge label={TRANSACTION_TYPE_LABELS[type] ?? type} tone={type === 'REVERSAL' ? 'neutral' : direction > 0 ? 'success' : 'info'} />
}

const DOC_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  OPEN: 'info',
  SUBMITTED: 'warning',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  POSTED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
}

export function DocumentStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={APPROVAL_STATUS_LABELS[status] ?? status} tone={DOC_TONE[status] ?? 'neutral'} />
}

const RES_TONE: Record<string, Tone> = {
  ACTIVE: 'warning',
  PARTIALLY_FULFILLED: 'info',
  FULFILLED: 'success',
  RELEASED: 'neutral',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
}

export function ReservationStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={RESERVATION_STATUS_LABELS[status] ?? status} tone={RES_TONE[status] ?? 'neutral'} />
}

export function AlertBadge({ type, severity }: { type: string; severity: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <AlertTriangle aria-hidden className={cn('size-3.5', severity === 'CRITICAL' ? 'text-shortage' : 'text-pending')} />
      <StatusBadge label={ALERT_TYPE_LABELS[type] ?? type} tone={severity === 'CRITICAL' ? 'danger' : 'warning'} />
    </span>
  )
}
