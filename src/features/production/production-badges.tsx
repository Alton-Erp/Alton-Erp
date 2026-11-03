import { Factory, Truck } from 'lucide-react'

import { StatusBadge } from '@/components/common/status-badge'
import type { Tone } from '@/config/status'
import {
  BOM_STATUS_LABELS,
  MATERIAL_STATUS_LABELS,
  OUTSOURCING_STATUS_LABELS,
  PRIORITY_LABELS,
  PRODUCTION_STATUS_LABELS,
  REQUIREMENT_STATUS_LABELS,
} from '@/features/production/production-model'
import { cn } from '@/lib/utils'

const ORDER_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  MATERIALS_RESERVED: 'info',
  MATERIALS_DISPATCHED: 'outsourced',
  IN_PROGRESS: 'info',
  PARTIALLY_COMPLETED: 'info',
  PARTIALLY_RECEIVED: 'outsourced',
  COMPLETED: 'success',
  ON_HOLD: 'warning',
  CANCELLED: 'neutral',
  REJECTED: 'danger',
  ARCHIVED: 'neutral',
}

export function ProductionStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={PRODUCTION_STATUS_LABELS[status] ?? status} tone={ORDER_TONE[status] ?? 'neutral'} />
}

export function OutsourcingStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={OUTSOURCING_STATUS_LABELS[status] ?? status} tone={ORDER_TONE[status] ?? 'neutral'} />
}

export function BomStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={BOM_STATUS_LABELS[status] ?? status} tone={status === 'APPROVED' ? 'success' : ORDER_TONE[status] ?? 'neutral'} />
}

const REQ_TONE: Record<string, Tone> = {
  SUFFICIENT: 'success',
  RESERVED: 'success',
  ISSUED: 'success',
  PARTIAL: 'warning',
  SHORTAGE: 'danger',
  INACTIVE: 'danger',
  UNIT_MISMATCH: 'danger',
}

export function RequirementBadge({ status }: { status: string }) {
  return <StatusBadge label={REQUIREMENT_STATUS_LABELS[status] ?? status} tone={REQ_TONE[status] ?? 'neutral'} />
}

export function MaterialStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={MATERIAL_STATUS_LABELS[status] ?? status} tone={status === 'FULLY_ISSUED' ? 'success' : status === 'PARTIALLY_ISSUED' ? 'info' : 'neutral'} />
}

export function PostedBadge({ status }: { status: string }) {
  return <StatusBadge label={status === 'REVERSED' ? 'Reversed' : 'Posted'} tone={status === 'REVERSED' ? 'neutral' : 'success'} />
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <StatusBadge label={PRIORITY_LABELS[priority] ?? priority} tone={priority === 'URGENT' ? 'danger' : priority === 'HIGH' ? 'warning' : 'neutral'} />
}

/** In-house (blue) vs outsourced (purple) indicator. */
export function MakeTypeBadge({ kind, className }: { kind: 'IN_HOUSE' | 'OUTSOURCED'; className?: string }) {
  const Icon = kind === 'IN_HOUSE' ? Factory : Truck
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
        kind === 'IN_HOUSE' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-violet-200 bg-violet-50 text-violet-700',
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {kind === 'IN_HOUSE' ? 'In-house' : 'Outsourced'}
    </span>
  )
}
