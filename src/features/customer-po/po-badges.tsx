import { StatusBadge } from '@/components/common/status-badge'
import type { Tone } from '@/config/status'
import { AVAILABILITY_LABELS, LINE_STATUS_LABELS, PO_STATUS_LABELS } from '@/features/customer-po/po-import'

const PO_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  UPLOADED: 'warning',
  VALIDATION_REQUIRED: 'warning',
  PRODUCT_MATCHING_REQUIRED: 'warning',
  READY_FOR_ALLOCATION: 'info',
  PARTIALLY_ALLOCATED: 'info',
  FULLY_ALLOCATED: 'success',
  PARTIALLY_FULFILLED: 'info',
  FULFILLED: 'success',
  ON_HOLD: 'warning',
  CANCELLED: 'neutral',
}

export function PoStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={PO_STATUS_LABELS[status] ?? status} tone={PO_TONE[status] ?? 'neutral'} />
}

const LINE_TONE: Record<string, Tone> = {
  MATCHED: 'success',
  UNMATCHED: 'danger',
  AMBIGUOUS: 'warning',
  INVALID: 'danger',
  DUPLICATE_REVIEW: 'warning',
  EXCLUDED: 'neutral',
}

export function LineStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={LINE_STATUS_LABELS[status] ?? status} tone={LINE_TONE[status] ?? 'neutral'} />
}

const AVAIL_TONE: Record<string, Tone> = {
  FULLY_AVAILABLE: 'success',
  PARTIALLY_AVAILABLE: 'warning',
  OUT_OF_STOCK: 'danger',
  PRODUCT_UNMATCHED: 'warning',
  UNIT_MISMATCH: 'danger',
  REVIEW_REQUIRED: 'warning',
  EXCLUDED: 'neutral',
}

export function AvailabilityBadge({ status }: { status: string }) {
  return <StatusBadge label={AVAILABILITY_LABELS[status] ?? status} tone={AVAIL_TONE[status] ?? 'neutral'} />
}
