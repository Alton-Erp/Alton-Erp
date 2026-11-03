import { ORDER_STATUS_META, type Tone } from '@/config/status'
import { cn } from '@/lib/utils'
import type { OrderStatus } from '@/types'

/*
 * Text uses darker shades of each indicator hue for WCAG-AA contrast on light
 * fills; the dot shows the exact brand indicator color.
 */
const TONE_CLASSES: Record<Tone, { badge: string; dot: string }> = {
  neutral: { badge: 'bg-gray-100 text-gray-700 border-gray-200', dot: 'bg-gray-400' },
  info: { badge: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-manufacturing' },
  outsourced: { badge: 'bg-violet-50 text-violet-700 border-violet-200', dot: 'bg-outsourced' },
  success: { badge: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-available' },
  warning: { badge: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-pending' },
  danger: { badge: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-shortage' },
}

interface StatusBadgeProps {
  label: string
  tone?: Tone
  className?: string
}

/** Generic status pill: label + tone. Color is never the only signal (the label is always shown). */
export function StatusBadge({ label, tone = 'neutral', className }: StatusBadgeProps) {
  const classes = TONE_CLASSES[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        classes.badge,
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', classes.dot)} />
      {label}
    </span>
  )
}

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  const meta = ORDER_STATUS_META[status]
  return <StatusBadge label={meta.label} tone={meta.tone} className={className} />
}
