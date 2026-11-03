import { StatusBadge } from '@/components/common/status-badge'
import { INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE, NOTE_STATUS_LABELS, NOTE_STATUS_TONE } from '@/features/billing/billing-model'

export function InvoiceStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={INVOICE_STATUS_LABELS[status] ?? status} tone={INVOICE_STATUS_TONE[status] ?? 'neutral'} />
}

export function NoteStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={NOTE_STATUS_LABELS[status] ?? status} tone={NOTE_STATUS_TONE[status] ?? 'neutral'} />
}

export function ReceiptStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={status === 'REVERSED' ? 'Reversed' : 'Recorded (unverified)'} tone={status === 'REVERSED' ? 'neutral' : 'info'} />
}
