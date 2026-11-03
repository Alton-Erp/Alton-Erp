import type { ActiveFilter } from '@/features/analytics/analytics-format'
import { formatIso } from '@/features/analytics/analytics-period'
import type { AnalyticsFilters } from '@/features/analytics/use-analytics'
import type { AnalyticsContext } from '@/services/analytics'

export interface FilterOption { value: string; label: string }
/** Active-filter labels shared by the analytics pages. */
export function activeFilters(filters: AnalyticsFilters, ctx: AnalyticsContext | null, extra: ActiveFilter[] = []): ActiveFilter[] {
  const out: ActiveFilter[] = []
  if (filters.warehouseId) out.push({ label: 'Warehouse', value: ctx?.warehouses.find((w) => w.id === filters.warehouseId)?.code ?? 'Selected' })
  if (filters.categoryId) out.push({ label: 'Category', value: ctx?.categories.find((c) => c.id === filters.categoryId)?.name ?? 'Selected' })
  if (filters.productId) out.push({ label: 'Product', value: filters.productLabel ?? 'Selected' })
  if (filters.sourceType) out.push({ label: 'Source', value: filters.sourceType === 'IN_HOUSE' ? 'In-house' : filters.sourceType === 'OUTSOURCED' ? 'Outsourced' : 'Unknown' })
  if (filters.orderStatus) out.push({ label: 'Order status', value: filters.orderStatus.toLowerCase().replace(/_/g, ' ') })
  if (filters.supplier) out.push({ label: 'Supplier', value: filters.supplier })
  if (filters.orderId) out.push({ label: 'Production order', value: filters.orderLabel ?? 'Selected' })
  if (filters.asOf) out.push({ label: 'As of', value: formatIso(filters.asOf) })
  return [...out, ...extra]
}

export const warehouseOptions = (ctx: AnalyticsContext | null): FilterOption[] => (ctx?.warehouses ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))
export const categoryOptions = (ctx: AnalyticsContext | null): FilterOption[] => (ctx?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))
export const SOURCE_OPTIONS: FilterOption[] = [{ value: 'IN_HOUSE', label: 'In-house' }, { value: 'OUTSOURCED', label: 'Outsourced' }, { value: 'UNKNOWN', label: 'Unknown (review)' }]
