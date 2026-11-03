import type { OrderStatus } from '@/types'

export type Tone = 'neutral' | 'info' | 'outsourced' | 'success' | 'warning' | 'danger'

export const ORDER_STATUS_META: Record<OrderStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  in_production: { label: 'In Production', tone: 'info' },
  shortage: { label: 'Shortage', tone: 'danger' },
  partially_dispatched: { label: 'Part Dispatched', tone: 'warning' },
  dispatched: { label: 'Dispatched', tone: 'success' },
  delivered: { label: 'Delivered', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}
