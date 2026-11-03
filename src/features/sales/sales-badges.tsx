import { StatusBadge } from '@/components/common/status-badge'
import {
  FULFILMENT_STATUS_LABELS,
  FULFILMENT_STATUS_TONE,
  ORDER_FULFILMENT_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_TONE,
} from '@/features/sales/sales-model'

export function SalesOrderStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={ORDER_STATUS_LABELS[status] ?? status} tone={ORDER_STATUS_TONE[status] ?? 'neutral'} />
}

export function OrderFulfilmentBadge({ status }: { status: string }) {
  const tone = status === 'DELIVERED' ? 'success' : status === 'NOT_STARTED' ? 'neutral' : status === 'IN_PROGRESS' ? 'info' : 'outsourced'
  return <StatusBadge label={ORDER_FULFILMENT_LABELS[status] ?? status} tone={tone} />
}

export function FulfilmentStatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge label={FULFILMENT_STATUS_LABELS[status] ?? status} tone={FULFILMENT_STATUS_TONE[status] ?? 'neutral'} />
      {overdue && <StatusBadge label="Overdue" tone="danger" />}
    </span>
  )
}

export function ReturnStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={RETURN_STATUS_LABELS[status] ?? status} tone={RETURN_STATUS_TONE[status] ?? 'neutral'} />
}
