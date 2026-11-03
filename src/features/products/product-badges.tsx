import { Blend, Factory, Truck } from 'lucide-react'

import { StatusBadge } from '@/components/common/status-badge'
import { SOURCE_TYPE_LABELS, type SourceType } from '@/features/products/product-model'
import { cn } from '@/lib/utils'
import type { ProductRow } from '@/types/database'

const SOURCE_STYLES: Record<SourceType, { icon: typeof Factory; className: string }> = {
  IN_HOUSE: { icon: Factory, className: 'bg-blue-50 text-blue-700 border-blue-200' },
  OUTSOURCED: { icon: Truck, className: 'bg-violet-50 text-violet-700 border-violet-200' },
  HYBRID: { icon: Blend, className: 'bg-teal-50 text-hybrid border-teal-200' },
}

/** Default sourcing strategy of a product (not the source of any stock unit). */
export function ProductSourceBadge({ source, className }: { source: SourceType; className?: string }) {
  const style = SOURCE_STYLES[source]
  const Icon = style.icon
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium', style.className, className)}
      title="Default source type"
    >
      <Icon aria-hidden className="size-3" />
      {SOURCE_TYPE_LABELS[source]}
    </span>
  )
}

export function ProductStatusBadge({ product }: { product: Pick<ProductRow, 'status' | 'archived_at'> }) {
  if (product.archived_at) return <StatusBadge label="Archived" tone="neutral" />
  return product.status === 'ACTIVE' ? <StatusBadge label="Active" tone="success" /> : <StatusBadge label="Inactive" tone="warning" />
}
