import { ArrowLeft, Filter, X } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'

import { DASHBOARDS, type DashboardKey, type DrillContext, type DrillMetric } from './drill-registry'
import { dashboardHref } from './use-drill'

/** Shown on a module list opened from a dashboard figure: which figure, its rule, and a way out. */
export function DrillBanner({ metric, ctx, via, total, onClear }: {
  metric: DrillMetric
  ctx: DrillContext
  via: DashboardKey | null
  total: number | null
  onClear: () => void
}) {
  const dash = via ?? metric.dashboard
  return (
    <div role="status" data-testid="drill-banner" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">
      <div className="flex min-w-0 items-start gap-2">
        <Filter aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p><span className="font-medium">{metric.label}</span> from the {DASHBOARDS[dash].label}{total !== null && <> · <span className="tabular-nums">{formatNumber(total)}</span> record{total === 1 ? '' : 's'}</>}</p>
          <p className="text-xs text-blue-900/80">{metric.definition}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" asChild><Link to={dashboardHref(dash, ctx)}><ArrowLeft /> Dashboard</Link></Button>
        <Button variant="outline" size="sm" onClick={onClear}><X /> Clear filters</Button>
      </div>
    </div>
  )
}
